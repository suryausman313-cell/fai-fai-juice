"""Database-backed Fai Fai admin login, accounts and safe data reset.

This router intentionally does not depend on the platform/OIDC admin JWT because the
Fai Fai admin panel uses its own username/password login. Passwords are stored as
PBKDF2 hashes and successful logins receive a signed, expiring admin token.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import MetaData, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from models.reward_settings import Reward_settings

router = APIRouter(
    prefix="/api/v1/fai-fai-admin-control",
    tags=["fai-fai-admin-control"],
)
logger = logging.getLogger(__name__)

TOKEN_TTL_SECONDS = 12 * 60 * 60
PBKDF2_ITERATIONS = 240_000
MAX_LOGIN_ATTEMPTS = 5
LOGIN_LOCK_SECONDS = 5 * 60

ALL_PERMISSIONS = {
    "orders": True,
    "menu": True,
    "sales": True,
    "customers": True,
    "settings": True,
    "deals": True,
    "notifications": True,
    "feedback": True,
    "accounts": True,
    "riders": True,
    "kitchen": True,
    "logs": True,
}

DEFAULT_STAFF_PERMISSIONS = {
    "orders": True,
    "menu": False,
    "sales": False,
    "customers": False,
    "settings": False,
    "deals": False,
    "notifications": False,
    "feedback": False,
    "accounts": False,
    "riders": False,
    "kitchen": False,
    "logs": False,
}

RESET_ROOTS: dict[str, set[str]] = {
    "orders": {
        "orders",
        "delivery_assignments",
        "rider_cash_submissions",
        "rider_cash_settlements",
        "order_print_logs",
        "receipt_print_logs",
    },
    "sales": {
        "orders",
        "delivery_assignments",
        "rider_cash_submissions",
        "rider_cash_settlements",
        "rider_payouts",
        "pickup_cash_settlements",
        "order_print_logs",
        "receipt_print_logs",
    },
    "menu": {"menu_items", "categories", "extras"},
    "customers": {"customer_sessions"},
    "rider_history": {
        "delivery_assignments",
        "rider_cash_submissions",
        "rider_cash_settlements",
        "rider_payouts",
        "rider_location_history",
    },
    "feedback": {"feedbacks"},
    "activity_logs": {"activity_logs"},
    "notifications": {"notifications", "app_notifications"},
    "all": {
        "orders",
        "delivery_assignments",
        "customer_sessions",
        "activity_logs",
        "feedbacks",
        "notifications",
        "app_notifications",
        "rider_cash_submissions",
        "rider_cash_settlements",
        "rider_payouts",
        "pickup_cash_settlements",
        "rider_location_history",
        "order_print_logs",
        "receipt_print_logs",
    },
}

RESET_MESSAGES = {
    "orders": "All orders, delivery assignments and related order records were deleted.",
    "sales": "Sales and revenue were reset by deleting all orders and related finance history.",
    "menu": "All menu items, categories and extras were deleted.",
    "customers": "All customer session and visitor records were deleted.",
    "rider_history": "Rider delivery and cash history were deleted. Rider accounts were preserved.",
    "feedback": "All customer feedback was deleted.",
    "activity_logs": "All admin activity logs were deleted.",
    "notifications": "All customer and app notifications were deleted.",
    "all": "Orders, sales, customer sessions, rider history, feedback, logs and notifications were deleted. Menu, settings, riders, deals, offers and admin accounts were preserved.",
}

PROTECTED_TABLES = {
    "admin_security",
    "admin_accounts_secure",
    "brand_settings",
    "restaurant_settings",
    "receipt_settings",
    "riders",
    "deals",
    "offers",
    "delivery_zones",
}


class AdminLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=300)


class SuperAdminUpdateRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=300)
    new_username: str = Field(min_length=3, max_length=120)
    new_password: str = Field(min_length=8, max_length=300)


class AdminAccountCreateRequest(BaseModel):
    username: str = Field(min_length=3, max_length=120)
    password: str = Field(min_length=8, max_length=300)
    role: str = Field(default="admin", max_length=30)
    branch_id: int = Field(ge=1)
    permissions: dict[str, bool] = Field(default_factory=lambda: dict(DEFAULT_STAFF_PERMISSIONS))


class AdminAccountUpdateRequest(BaseModel):
    username: Optional[str] = Field(default=None, min_length=3, max_length=120)
    password: Optional[str] = Field(default=None, min_length=8, max_length=300)
    role: Optional[str] = Field(default=None, max_length=30)
    branch_id: Optional[int] = Field(default=None, ge=1)
    permissions: Optional[dict[str, bool]] = None
    is_active: Optional[bool] = None


class ResetRequest(BaseModel):
    reset_type: str = Field(min_length=1, max_length=50)
    confirmation: str = Field(min_length=1, max_length=100)


class RewardSettingsUpdateRequest(BaseModel):
    enabled: bool


@dataclass
class AdminIdentity:
    subject: str
    username: str
    role: str
    permissions: dict[str, bool]
    token_version: int
    branch_id: Optional[int] = None


# ---------------------------------------------------------------------------
# Security helpers
# ---------------------------------------------------------------------------


def _security_secret() -> str:
    value = os.getenv("FAI_FAI_SETTINGS_KEY", "").strip()
    if len(value) < 8:
        raise HTTPException(
            status_code=503,
            detail="FAI_FAI_SETTINGS_KEY is missing in Render Environment.",
        )
    return value


def _password_hash(password: str, salt_hex: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        bytes.fromhex(salt_hex),
        PBKDF2_ITERATIONS,
    ).hex()


def _new_password_record(password: str) -> tuple[str, str]:
    salt = secrets.token_hex(16)
    return salt, _password_hash(password, salt)


def _verify_password(password: str, salt: str, expected_hash: str) -> bool:
    try:
        calculated = _password_hash(password, salt)
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(calculated, expected_hash)


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(value: str) -> bytes:
    padding = "=" * ((4 - len(value) % 4) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def _create_token(identity: AdminIdentity) -> str:
    payload = {
        "sub": identity.subject,
        "username": identity.username,
        "role": identity.role,
        "permissions": identity.permissions,
        "branch_id": identity.branch_id,
        "ver": identity.token_version,
        "exp": int(time.time()) + TOKEN_TTL_SECONDS,
        "nonce": secrets.token_hex(8),
    }
    segment = _b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    signature = hmac.new(
        _security_secret().encode("utf-8"),
        segment.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{segment}.{_b64encode(signature)}"


def _decode_token(token: str) -> dict[str, Any]:
    try:
        segment, signature_segment = token.split(".", 1)
        supplied_signature = _b64decode(signature_segment)
        expected_signature = hmac.new(
            _security_secret().encode("utf-8"),
            segment.encode("ascii"),
            hashlib.sha256,
        ).digest()
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise ValueError("bad signature")

        payload = json.loads(_b64decode(segment).decode("utf-8"))
        if int(payload.get("exp", 0)) < int(time.time()):
            raise ValueError("expired")
        return payload
    except Exception as exc:
        raise HTTPException(status_code=401, detail="Admin session expired. Login again.") from exc


def _normalise_permissions(value: Optional[dict[str, bool]]) -> dict[str, bool]:
    source = value or {}
    return {
        key: bool(source.get(key, DEFAULT_STAFF_PERMISSIONS[key]))
        for key in DEFAULT_STAFF_PERMISSIONS
    }


def _parse_permissions(raw: Any) -> dict[str, bool]:
    if isinstance(raw, dict):
        return _normalise_permissions(raw)
    try:
        return _normalise_permissions(json.loads(raw or "{}"))
    except Exception:
        return dict(DEFAULT_STAFF_PERMISSIONS)


async def _add_column_if_missing(
    db: AsyncSession,
    table_name: str,
    column_name: str,
    column_sql: str,
) -> None:
    """Add a migration column safely on both Render/Postgres and local SQLite."""
    dialect = db.get_bind().dialect.name
    if dialect == "sqlite":
        result = await db.execute(text(f"PRAGMA table_info({table_name})"))
        existing_columns = {str(row[1]) for row in result.fetchall()}
        if column_name not in existing_columns:
            await db.execute(
                text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_sql}")
            )
        return

    await db.execute(
        text(
            f"ALTER TABLE {table_name} "
            f"ADD COLUMN IF NOT EXISTS {column_name} {column_sql}"
        )
    )


def _login_lock_remaining_seconds(locked_until_epoch: Any) -> int:
    try:
        locked_until = int(locked_until_epoch or 0)
    except (TypeError, ValueError):
        locked_until = 0
    return max(0, locked_until - int(time.time()))


def _login_lock_error(remaining_seconds: int) -> HTTPException:
    remaining_minutes = max(1, (remaining_seconds + 59) // 60)
    return HTTPException(
        status_code=429,
        detail=f"Too many wrong login attempts. Try again in {remaining_minutes} minute(s).",
    )


async def _reset_super_login_failures(db: AsyncSession) -> None:
    await db.execute(
        text(
            """
            UPDATE admin_security
            SET failed_login_attempts = 0, locked_until_epoch = 0
            WHERE id = 1
            """
        )
    )
    await db.commit()


async def _record_super_login_failure(
    db: AsyncSession,
    current_attempts: Any,
) -> bool:
    try:
        attempts = int(current_attempts or 0) + 1
    except (TypeError, ValueError):
        attempts = 1

    if attempts >= MAX_LOGIN_ATTEMPTS:
        await db.execute(
            text(
                """
                UPDATE admin_security
                SET failed_login_attempts = 0,
                    locked_until_epoch = :locked_until
                WHERE id = 1
                """
            ),
            {"locked_until": int(time.time()) + LOGIN_LOCK_SECONDS},
        )
        await db.commit()
        return True

    await db.execute(
        text(
            """
            UPDATE admin_security
            SET failed_login_attempts = :attempts
            WHERE id = 1
            """
        ),
        {"attempts": attempts},
    )
    await db.commit()
    return False


async def _reset_staff_login_failures(db: AsyncSession, account_id: str) -> None:
    await db.execute(
        text(
            """
            UPDATE admin_accounts_secure
            SET failed_login_attempts = 0, locked_until_epoch = 0
            WHERE id = :id
            """
        ),
        {"id": account_id},
    )
    await db.commit()


async def _record_staff_login_failure(
    db: AsyncSession,
    account_id: str,
    current_attempts: Any,
) -> bool:
    try:
        attempts = int(current_attempts or 0) + 1
    except (TypeError, ValueError):
        attempts = 1

    if attempts >= MAX_LOGIN_ATTEMPTS:
        await db.execute(
            text(
                """
                UPDATE admin_accounts_secure
                SET failed_login_attempts = 0,
                    locked_until_epoch = :locked_until
                WHERE id = :id
                """
            ),
            {
                "id": account_id,
                "locked_until": int(time.time()) + LOGIN_LOCK_SECONDS,
            },
        )
        await db.commit()
        return True

    await db.execute(
        text(
            """
            UPDATE admin_accounts_secure
            SET failed_login_attempts = :attempts
            WHERE id = :id
            """
        ),
        {"id": account_id, "attempts": attempts},
    )
    await db.commit()
    return False


async def ensure_admin_tables(db: AsyncSession) -> None:
    await db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS admin_security (
                id INTEGER PRIMARY KEY,
                username VARCHAR(120) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                token_version INTEGER NOT NULL DEFAULT 1,
                failed_login_attempts INTEGER NOT NULL DEFAULT 0,
                locked_until_epoch BIGINT NOT NULL DEFAULT 0,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )
    await db.execute(
        text(
            """
            CREATE TABLE IF NOT EXISTS admin_accounts_secure (
                id VARCHAR(36) PRIMARY KEY,
                username VARCHAR(120) NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                salt TEXT NOT NULL,
                role VARCHAR(30) NOT NULL DEFAULT 'admin',
                branch_id INTEGER NULL,
                permissions_json TEXT NOT NULL DEFAULT '{}',
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                token_version INTEGER NOT NULL DEFAULT 1,
                failed_login_attempts INTEGER NOT NULL DEFAULT 0,
                locked_until_epoch BIGINT NOT NULL DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
    )

    # Backward-compatible migration for existing production/local databases.
    await _add_column_if_missing(
        db, "admin_accounts_secure", "branch_id", "INTEGER NULL"
    )
    await _add_column_if_missing(
        db, "admin_security", "failed_login_attempts", "INTEGER NOT NULL DEFAULT 0"
    )
    await _add_column_if_missing(
        db, "admin_security", "locked_until_epoch", "BIGINT NOT NULL DEFAULT 0"
    )
    await _add_column_if_missing(
        db, "admin_accounts_secure", "failed_login_attempts", "INTEGER NOT NULL DEFAULT 0"
    )
    await _add_column_if_missing(
        db, "admin_accounts_secure", "locked_until_epoch", "BIGINT NOT NULL DEFAULT 0"
    )

    existing = await db.execute(text("SELECT id FROM admin_security WHERE id = 1"))
    if existing.first() is None:
        initial_username = os.getenv("INITIAL_ADMIN_USERNAME", "").strip()
        initial_password = os.getenv("INITIAL_ADMIN_PASSWORD", "")
        if len(initial_username) < 3 or len(initial_password) < 8:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Set INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD "
                    "in Render Environment for first-time Admin setup."
                ),
            )

        salt, password_hash = _new_password_record(initial_password)
        await db.execute(
            text(
                """
                INSERT INTO admin_security
                    (id, username, password_hash, salt, token_version)
                VALUES
                    (1, :username, :password_hash, :salt, 1)
                """
            ),
            {
                "username": initial_username,
                "password_hash": password_hash,
                "salt": salt,
            },
        )

    # Existing staff accounts from the old single-branch app are kept and bound
    # to the original/default branch. Super Admin remains global.
    await db.execute(text("""
        UPDATE admin_accounts_secure
        SET branch_id = COALESCE(
            branch_id,
            (SELECT id FROM branches WHERE is_default = TRUE ORDER BY id LIMIT 1),
            (SELECT id FROM branches ORDER BY id LIMIT 1)
        )
        WHERE branch_id IS NULL
    """))
    await db.commit()


async def _username_exists(
    db: AsyncSession,
    username: str,
    exclude_account_id: Optional[str] = None,
    exclude_super: bool = False,
) -> bool:
    lowered = username.strip().lower()

    if not exclude_super:
        super_result = await db.execute(
            text("SELECT id FROM admin_security WHERE LOWER(username) = :username"),
            {"username": lowered},
        )
        if super_result.first() is not None:
            return True

    query = "SELECT id FROM admin_accounts_secure WHERE LOWER(username) = :username"
    params: dict[str, Any] = {"username": lowered}
    if exclude_account_id:
        query += " AND id <> :exclude_id"
        params["exclude_id"] = exclude_account_id

    account_result = await db.execute(text(query), params)
    return account_result.first() is not None


async def _default_branch_id(db: AsyncSession) -> Optional[int]:
    try:
        result = await db.execute(
            text("SELECT id FROM branches WHERE is_default = TRUE ORDER BY id LIMIT 1")
        )
        value = result.scalar_one_or_none()
        if value is None:
            result = await db.execute(text("SELECT id FROM branches ORDER BY id LIMIT 1"))
            value = result.scalar_one_or_none()
        return int(value) if value is not None else None
    except Exception:
        return None


async def _require_valid_branch(db: AsyncSession, branch_id: int) -> int:
    result = await db.execute(
        text("SELECT id FROM branches WHERE id = :id AND is_active = TRUE"),
        {"id": int(branch_id)},
    )
    value = result.scalar_one_or_none()
    if value is None:
        raise HTTPException(status_code=400, detail="Select an active branch for this Admin account.")
    return int(value)


async def get_current_admin(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
) -> AdminIdentity:
    await ensure_admin_tables(db)

    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Admin login required.")

    payload = _decode_token(authorization.split(" ", 1)[1].strip())
    subject = str(payload.get("sub", ""))
    token_version = int(payload.get("ver", 0))

    if subject == "super":
        result = await db.execute(
            text(
                """
                SELECT username, token_version
                FROM admin_security
                WHERE id = 1
                """
            )
        )
        row = result.mappings().first()
        if row is None or int(row["token_version"]) != token_version:
            raise HTTPException(status_code=401, detail="Admin session is no longer valid.")
        return AdminIdentity(
            subject="super",
            username=str(row["username"]),
            role="super_admin",
            permissions=dict(ALL_PERMISSIONS),
            token_version=int(row["token_version"]),
        )

    result = await db.execute(
        text(
            """
            SELECT id, username, role, branch_id, permissions_json, is_active, token_version
            FROM admin_accounts_secure
            WHERE id = :id
            """
        ),
        {"id": subject},
    )
    row = result.mappings().first()
    if (
        row is None
        or not bool(row["is_active"])
        or int(row["token_version"]) != token_version
    ):
        raise HTTPException(status_code=401, detail="Admin account is inactive or changed.")

    return AdminIdentity(
        subject=str(row["id"]),
        username=str(row["username"]),
        role=str(row["role"]),
        permissions=_parse_permissions(row["permissions_json"]),
        token_version=int(row["token_version"]),
        branch_id=(int(row["branch_id"]) if row.get("branch_id") is not None else await _default_branch_id(db)),
    )


def require_super_admin(identity: AdminIdentity) -> None:
    if identity.role != "super_admin":
        raise HTTPException(status_code=403, detail="Only Super Admin can do this.")


def require_accounts_permission(identity: AdminIdentity) -> None:
    if identity.role != "super_admin" and not identity.permissions.get("accounts"):
        raise HTTPException(status_code=403, detail="Admin Accounts permission is required.")


def require_settings_permission(identity: AdminIdentity) -> None:
    if identity.role != "super_admin" and not identity.permissions.get("settings"):
        raise HTTPException(status_code=403, detail="Settings permission is required.")


# ---------------------------------------------------------------------------
# Login and account endpoints
# ---------------------------------------------------------------------------


@router.post("/login")
async def login_admin(
    data: AdminLoginRequest,
    db: AsyncSession = Depends(get_db),
):
    await ensure_admin_tables(db)
    username = data.username.strip().lower()

    super_result = await db.execute(
        text(
            """
            SELECT username, password_hash, salt, token_version,
                   failed_login_attempts, locked_until_epoch
            FROM admin_security
            WHERE LOWER(username) = :username
            """
        ),
        {"username": username},
    )
    super_row = super_result.mappings().first()
    if super_row:
        remaining = _login_lock_remaining_seconds(super_row["locked_until_epoch"])
        if remaining > 0:
            raise _login_lock_error(remaining)

        if _verify_password(
            data.password,
            str(super_row["salt"]),
            str(super_row["password_hash"]),
        ):
            await _reset_super_login_failures(db)
            identity = AdminIdentity(
                subject="super",
                username=str(super_row["username"]),
                role="super_admin",
                permissions=dict(ALL_PERMISSIONS),
                token_version=int(super_row["token_version"]),
            )
            return {
                "success": True,
                "token": _create_token(identity),
                "expires_in": TOKEN_TTL_SECONDS,
                "username": identity.username,
                "role": identity.role,
                "permissions": identity.permissions,
                "branch_id": None,
            }

        locked = await _record_super_login_failure(
            db, super_row["failed_login_attempts"]
        )
        if locked:
            raise _login_lock_error(LOGIN_LOCK_SECONDS)

    account_result = await db.execute(
        text(
            """
            SELECT id, username, password_hash, salt, role, branch_id,
                   permissions_json, is_active, token_version,
                   failed_login_attempts, locked_until_epoch
            FROM admin_accounts_secure
            WHERE LOWER(username) = :username
            """
        ),
        {"username": username},
    )
    account = account_result.mappings().first()
    if account and bool(account["is_active"]):
        remaining = _login_lock_remaining_seconds(account["locked_until_epoch"])
        if remaining > 0:
            raise _login_lock_error(remaining)

        if _verify_password(
            data.password,
            str(account["salt"]),
            str(account["password_hash"]),
        ):
            await _reset_staff_login_failures(db, str(account["id"]))
            identity = AdminIdentity(
                subject=str(account["id"]),
                username=str(account["username"]),
                role=str(account["role"]),
                permissions=_parse_permissions(account["permissions_json"]),
                token_version=int(account["token_version"]),
                branch_id=(
                    int(account["branch_id"])
                    if account.get("branch_id") is not None
                    else await _default_branch_id(db)
                ),
            )
            return {
                "success": True,
                "token": _create_token(identity),
                "expires_in": TOKEN_TTL_SECONDS,
                "username": identity.username,
                "role": identity.role,
                "permissions": identity.permissions,
                "branch_id": identity.branch_id,
            }

        locked = await _record_staff_login_failure(
            db, str(account["id"]), account["failed_login_attempts"]
        )
        if locked:
            raise _login_lock_error(LOGIN_LOCK_SECONDS)

    raise HTTPException(status_code=401, detail="Invalid username or password.")


@router.get("/me")
async def admin_me(identity: AdminIdentity = Depends(get_current_admin)):
    return {
        "username": identity.username,
        "role": identity.role,
        "permissions": identity.permissions,
        "branch_id": identity.branch_id,
    }


@router.get("/reward-settings")
async def get_reward_settings_admin_control(
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_settings_permission(identity)
    row = await db.scalar(
        select(Reward_settings).order_by(Reward_settings.id.asc()).limit(1)
    )
    if row is None:
        row = Reward_settings(enabled=True)
        db.add(row)
        await db.commit()
        await db.refresh(row)
    return {"enabled": bool(row.enabled)}


@router.put("/reward-settings")
async def update_reward_settings_admin_control(
    body: RewardSettingsUpdateRequest,
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_settings_permission(identity)
    row = await db.scalar(
        select(Reward_settings).order_by(Reward_settings.id.asc()).limit(1)
    )
    if row is None:
        row = Reward_settings(enabled=bool(body.enabled))
        db.add(row)
    else:
        row.enabled = bool(body.enabled)
    await db.commit()
    return {
        "enabled": bool(body.enabled),
        "message": "Rewards turned ON" if body.enabled else "Rewards turned OFF",
    }


@router.put("/super-admin")
async def update_super_admin(
    data: SuperAdminUpdateRequest,
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_super_admin(identity)
    await ensure_admin_tables(db)

    current_result = await db.execute(
        text(
            """
            SELECT password_hash, salt
            FROM admin_security
            WHERE id = 1
            """
        )
    )
    current = current_result.mappings().first()
    if current is None or not _verify_password(
        data.current_password,
        str(current["salt"]),
        str(current["password_hash"]),
    ):
        raise HTTPException(status_code=400, detail="Current password is incorrect.")

    new_username = data.new_username.strip()
    if await _username_exists(db, new_username, exclude_super=True):
        raise HTTPException(status_code=409, detail="Username is already in use.")

    salt, password_hash = _new_password_record(data.new_password)
    await db.execute(
        text(
            """
            UPDATE admin_security
            SET username = :username,
                password_hash = :password_hash,
                salt = :salt,
                token_version = token_version + 1,
                failed_login_attempts = 0,
                locked_until_epoch = 0,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = 1
            """
        ),
        {
            "username": new_username,
            "password_hash": password_hash,
            "salt": salt,
        },
    )
    await db.commit()

    return {
        "success": True,
        "message": "Super Admin username and password changed. Login again with the new details.",
        "username": new_username,
    }


@router.get("/accounts")
async def list_admin_accounts(
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_accounts_permission(identity)
    await ensure_admin_tables(db)

    result = await db.execute(
        text(
            """
            SELECT id, username, role, branch_id, permissions_json, is_active,
                   created_at, updated_at
            FROM admin_accounts_secure
            WHERE (:is_super = TRUE OR branch_id = :branch_id)
            ORDER BY created_at ASC
            """
        ),
        {"is_super": identity.role == "super_admin", "branch_id": identity.branch_id},
    )
    accounts = []
    for row in result.mappings().all():
        accounts.append(
            {
                "id": str(row["id"]),
                "username": str(row["username"]),
                "role": str(row["role"]),
                "branch_id": (int(row["branch_id"]) if row.get("branch_id") is not None else await _default_branch_id(db)),
                "permissions": _parse_permissions(row["permissions_json"]),
                "is_active": bool(row["is_active"]),
                "created_at": row["created_at"].isoformat()
                if row["created_at"]
                else None,
                "updated_at": row["updated_at"].isoformat()
                if row["updated_at"]
                else None,
            }
        )
    return {"items": accounts}


@router.post("/accounts")
async def create_admin_account(
    data: AdminAccountCreateRequest,
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_accounts_permission(identity)
    await ensure_admin_tables(db)

    username = data.username.strip()
    if await _username_exists(db, username):
        raise HTTPException(status_code=409, detail="Username is already in use.")

    role = data.role.strip().lower()
    if role not in {"admin", "manager"}:
        raise HTTPException(status_code=400, detail="Role must be admin or manager.")

    requested_branch_id = data.branch_id if identity.role == "super_admin" else identity.branch_id
    if requested_branch_id is None:
        raise HTTPException(status_code=403, detail="This Admin is not assigned to a branch.")
    branch_id = await _require_valid_branch(db, int(requested_branch_id))
    account_id = str(uuid.uuid4())
    salt, password_hash = _new_password_record(data.password)
    permissions = _normalise_permissions(data.permissions)

    await db.execute(
        text(
            """
            INSERT INTO admin_accounts_secure
                (id, username, password_hash, salt, role, branch_id,
                 permissions_json, is_active, token_version)
            VALUES
                (:id, :username, :password_hash, :salt, :role, :branch_id,
                 :permissions_json, TRUE, 1)
            """
        ),
        {
            "id": account_id,
            "username": username,
            "password_hash": password_hash,
            "salt": salt,
            "role": role,
            "branch_id": branch_id,
            "permissions_json": json.dumps(permissions),
        },
    )
    await db.commit()

    return {
        "success": True,
        "message": f'Admin account "{username}" created.',
        "account": {
            "id": account_id,
            "username": username,
            "role": role,
            "branch_id": branch_id,
            "permissions": permissions,
            "is_active": True,
        },
    }


@router.put("/accounts/{account_id}")
async def update_admin_account(
    account_id: str,
    data: AdminAccountUpdateRequest,
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_accounts_permission(identity)
    await ensure_admin_tables(db)

    current_result = await db.execute(
        text(
            """
            SELECT id, username, role, branch_id, permissions_json, is_active
            FROM admin_accounts_secure
            WHERE id = :id
            """
        ),
        {"id": account_id},
    )
    current = current_result.mappings().first()
    if current is None:
        raise HTTPException(status_code=404, detail="Admin account not found.")
    current_branch_id = int(current["branch_id"]) if current.get("branch_id") is not None else await _default_branch_id(db)
    if identity.role != "super_admin" and current_branch_id != identity.branch_id:
        raise HTTPException(status_code=403, detail="You can only manage Admin accounts for your own branch.")

    updates: list[str] = []
    params: dict[str, Any] = {"id": account_id}

    if data.username is not None:
        username = data.username.strip()
        if await _username_exists(db, username, exclude_account_id=account_id):
            raise HTTPException(status_code=409, detail="Username is already in use.")
        updates.append("username = :username")
        params["username"] = username

    if data.password is not None:
        salt, password_hash = _new_password_record(data.password)
        updates.extend(
            [
                "password_hash = :password_hash",
                "salt = :salt",
                "failed_login_attempts = 0",
                "locked_until_epoch = 0",
            ]
        )
        params["password_hash"] = password_hash
        params["salt"] = salt

    if data.role is not None:
        role = data.role.strip().lower()
        if role not in {"admin", "manager"}:
            raise HTTPException(status_code=400, detail="Role must be admin or manager.")
        updates.append("role = :role")
        params["role"] = role

    if data.branch_id is not None:
        if identity.role != "super_admin" and int(data.branch_id) != int(identity.branch_id or 0):
            raise HTTPException(status_code=403, detail="Only Super Admin can move an account to another branch.")
        params["branch_id"] = await _require_valid_branch(db, data.branch_id)
        updates.append("branch_id = :branch_id")

    if data.permissions is not None:
        updates.append("permissions_json = :permissions_json")
        params["permissions_json"] = json.dumps(
            _normalise_permissions(data.permissions)
        )

    if data.is_active is not None:
        updates.append("is_active = :is_active")
        params["is_active"] = bool(data.is_active)

    if not updates:
        return {"success": True, "message": "No changes supplied."}

    updates.extend(
        [
            "token_version = token_version + 1",
            "updated_at = CURRENT_TIMESTAMP",
        ]
    )
    await db.execute(
        text(
            f"UPDATE admin_accounts_secure SET {', '.join(updates)} WHERE id = :id"
        ),
        params,
    )
    await db.commit()
    return {"success": True, "message": "Admin account updated."}


@router.delete("/accounts/{account_id}")
async def delete_admin_account(
    account_id: str,
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_accounts_permission(identity)
    await ensure_admin_tables(db)

    current = (await db.execute(
        text("SELECT id, branch_id FROM admin_accounts_secure WHERE id = :id"),
        {"id": account_id},
    )).mappings().first()
    if current is None:
        raise HTTPException(status_code=404, detail="Admin account not found.")
    current_branch_id = int(current["branch_id"]) if current.get("branch_id") is not None else await _default_branch_id(db)
    if identity.role != "super_admin" and current_branch_id != identity.branch_id:
        raise HTTPException(status_code=403, detail="You can only manage Admin accounts for your own branch.")
    await db.execute(text("DELETE FROM admin_accounts_secure WHERE id = :id"), {"id": account_id})
    await db.commit()
    return {"success": True, "message": "Admin account deleted."}


# ---------------------------------------------------------------------------
# Data reset endpoints
# ---------------------------------------------------------------------------


async def _reflect_metadata(db: AsyncSession) -> MetaData:
    connection = await db.connection()

    def reflect(sync_connection):
        metadata = MetaData()
        metadata.reflect(bind=sync_connection)
        return metadata

    return await connection.run_sync(reflect)


def _expand_dependent_tables(metadata: MetaData, roots: set[str]) -> set[str]:
    available = set(metadata.tables.keys())
    selected = {name for name in roots if name in available}

    changed = True
    while changed:
        changed = False
        for table in metadata.tables.values():
            if table.name in selected or table.name in PROTECTED_TABLES:
                continue
            if any(fk.column.table.name in selected for fk in table.foreign_keys):
                selected.add(table.name)
                changed = True
    return selected


async def _count_tables(
    db: AsyncSession,
    metadata: MetaData,
    table_names: set[str],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    for table in metadata.sorted_tables:
        if table.name not in table_names:
            continue
        result = await db.execute(select(func.count()).select_from(table))
        counts[table.name] = int(result.scalar() or 0)
    return counts


async def _preview_resets(db: AsyncSession) -> dict[str, Any]:
    metadata = await _reflect_metadata(db)
    result: dict[str, Any] = {}
    for reset_type, roots in RESET_ROOTS.items():
        selected = _expand_dependent_tables(metadata, roots)
        counts = await _count_tables(db, metadata, selected)
        result[reset_type] = {
            "rows": sum(counts.values()),
            "tables": counts,
        }
    return result


@router.get("/reset/preview")
async def reset_preview(
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_super_admin(identity)
    return {"resets": await _preview_resets(db)}


@router.post("/reset")
async def reset_data(
    data: ResetRequest,
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    require_super_admin(identity)
    reset_type = data.reset_type.strip().lower()
    if reset_type not in RESET_ROOTS:
        raise HTTPException(status_code=400, detail="Unknown reset type.")

    expected_confirmation = (
        "RESET ALL DATA" if reset_type == "all" else f"RESET {reset_type.replace('_', ' ').upper()}"
    )
    if data.confirmation.strip().upper() != expected_confirmation:
        raise HTTPException(
            status_code=400,
            detail=f'Type "{expected_confirmation}" exactly to confirm.',
        )

    metadata = await _reflect_metadata(db)
    selected = _expand_dependent_tables(metadata, RESET_ROOTS[reset_type])
    counts = await _count_tables(db, metadata, selected)

    try:
        for table in reversed(metadata.sorted_tables):
            if table.name in selected:
                await db.execute(table.delete())

        # Deleting test orders must also restart the public order number.
        # PostgreSQL DELETE alone does not reset its auto-increment sequence.
        if "orders" in selected:
            dialect = db.get_bind().dialect.name
            if dialect == "postgresql":
                await db.execute(text("ALTER SEQUENCE orders_id_seq RESTART WITH 1"))
            elif dialect == "sqlite":
                await db.execute(
                    text("DELETE FROM sqlite_sequence WHERE name = 'orders'")
                )
        await db.commit()
    except Exception as exc:
        await db.rollback()
        logger.exception("Fai Fai reset failed for %s", reset_type)
        raise HTTPException(
            status_code=500,
            detail=f"Reset failed: {exc}",
        ) from exc

    return {
        "success": True,
        "reset_type": reset_type,
        "message": RESET_MESSAGES[reset_type],
        "deleted_rows": sum(counts.values()),
        "deleted_tables": counts,
        "order_number_restarted": "orders" in selected,
    }
