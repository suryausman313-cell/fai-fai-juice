# @File: app/backend/routers/fai_fai_customer_admin_v3.py
# @Desc: Fai Fai Customer Management V3
#
# IMPORTANT:
# - This router does NOT use get_current_user.
# - This router does NOT use Authorization: Bearer.
# - It uses only the custom X-Fai-Fai-Admin-Key header.
# - Its URL is unique, so it cannot conflict with old admin_customer_pin.py routes.

import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from models.customer_pin_accounts_v2 import Customer_pin_accounts_v2
from models.customer_sessions import Customer_sessions
from models.orders import Orders

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/v1/fai-fai-customer-admin-v3",
    tags=["fai-fai-customer-admin-v3"],
)

PIN_ITERATIONS = 310_000


class ResetCustomerPinRequest(BaseModel):
    phone: str = Field(min_length=8, max_length=32)
    new_pin: str = Field(min_length=4, max_length=4)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def as_aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def iso(value: Optional[datetime]) -> Optional[str]:
    normalized = as_aware(value)
    return normalized.isoformat() if normalized else None


def get_admin_key() -> str:
    key = (os.getenv("FAI_FAI_SETTINGS_KEY") or "").strip()

    if len(key) < 8:
        raise HTTPException(
            status_code=500,
            detail="FAI_FAI_SETTINGS_KEY is missing in Render Environment",
        )

    return key


async def require_fai_fai_admin_key(
    x_fai_fai_admin_key: Optional[str] = Header(
        default=None,
        alias="X-Fai-Fai-Admin-Key",
    ),
) -> None:
    supplied = (x_fai_fai_admin_key or "").strip()
    expected = get_admin_key()

    if not supplied:
        raise HTTPException(
            status_code=401,
            detail="Enter FAI_FAI_SETTINGS_KEY to unlock Customer Management",
        )

    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(
            status_code=401,
            detail="FAI_FAI_SETTINGS_KEY is incorrect",
        )


def normalize_phone(raw_value: str) -> str:
    raw = (raw_value or "").strip()

    if not raw:
        raise HTTPException(status_code=400, detail="Mobile number is required")

    digits = re.sub(r"\D", "", raw)

    if raw.startswith("+"):
        normalized = f"+{digits}"
    elif digits.startswith("00"):
        normalized = f"+{digits[2:]}"
    elif digits.startswith("971"):
        normalized = f"+{digits}"
    elif digits.startswith("0") and 9 <= len(digits) <= 10:
        normalized = f"+971{digits[1:]}"
    else:
        raise HTTPException(
            status_code=400,
            detail="Use country code, for example +971501234567",
        )

    if not re.fullmatch(r"\+[1-9]\d{7,14}", normalized):
        raise HTTPException(status_code=400, detail="Invalid mobile number")

    return normalized


def phone_key(raw_value: Optional[str]) -> str:
    digits = re.sub(r"\D", "", raw_value or "")

    if digits.startswith("00971"):
        digits = digits[2:]
    elif digits.startswith("0") and len(digits) >= 9:
        digits = f"971{digits[1:]}"

    return digits[-9:] if len(digits) >= 9 else digits


def validate_pin(pin: str) -> str:
    value = (pin or "").strip()

    if not re.fullmatch(r"\d{4}", value):
        raise HTTPException(
            status_code=400,
            detail="New PIN must be exactly 4 digits",
        )

    return value


def hash_pin(pin: str) -> tuple[str, str]:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        pin.encode("utf-8"),
        salt,
        PIN_ITERATIONS,
    )

    return (
        base64.urlsafe_b64encode(digest).decode("ascii"),
        base64.urlsafe_b64encode(salt).decode("ascii"),
    )


@router.get("/health")
async def health():
    return {
        "success": True,
        "version": "v3-final",
        "uses_platform_auth": False,
        "uses_authorization_bearer": False,
        "security_header": "X-Fai-Fai-Admin-Key",
    }


@router.get("/verify")
async def verify_key(
    _admin: None = Depends(require_fai_fai_admin_key),
):
    return {
        "success": True,
        "message": "Customer Management unlocked",
    }


@router.get("/customers")
async def list_registered_customers(
    search: Optional[str] = Query(default=None, max_length=100),
    limit: int = Query(default=500, ge=1, le=1000),
    _admin: None = Depends(require_fai_fai_admin_key),
    db: AsyncSession = Depends(get_db),
):
    account_query = select(Customer_pin_accounts_v2).order_by(
        desc(Customer_pin_accounts_v2.updated_at)
    )

    account_result = await db.execute(account_query.limit(limit))
    accounts = account_result.scalars().all()

    order_result = await db.execute(select(Orders))
    orders = order_result.scalars().all()

    google_result = await db.execute(
        select(Customer_sessions)
        .where(Customer_sessions.user_id.ilike("google:%"))
        .order_by(desc(Customer_sessions.id))
    )
    google_sessions = google_result.scalars().all()
    google_by_phone: dict[str, Customer_sessions] = {}
    for session in google_sessions:
        key = phone_key(session.customer_phone)
        if key and key not in google_by_phone:
            google_by_phone[key] = session

    stats: dict[str, dict] = {}

    for order in orders:
        key = phone_key(getattr(order, "customer_phone", None))
        if not key:
            continue

        status = str(getattr(order, "status", "") or "").lower()
        total_amount = float(getattr(order, "total_amount", 0) or 0)
        created_at = as_aware(getattr(order, "created_at", None))

        row = stats.setdefault(
            key,
            {
                "total_orders": 0,
                "total_spent": 0.0,
                "last_order_date": None,
            },
        )

        if status not in {"cancelled", "canceled", "deleted", "refunded", "expired", "payment_pending"}:
            row["total_orders"] += 1
        if status in {"completed", "delivered"}:
            row["total_spent"] += total_amount

        if created_at and (
            row["last_order_date"] is None
            or created_at > row["last_order_date"]
        ):
            row["last_order_date"] = created_at

    query_text = (search or "").strip().lower()
    now = utc_now()
    items = []

    for account in accounts:
        key = phone_key(account.phone)
        google_session = google_by_phone.get(key)
        google_email = str(
            getattr(google_session, "customer_email", "") or ""
        ).strip()

        if query_text:
            if (
                query_text not in str(account.customer_name or "").lower()
                and query_text not in str(account.phone or "").lower()
                and query_text not in google_email.lower()
            ):
                continue

        order_stats = stats.get(
            key,
            {
                "total_orders": 0,
                "total_spent": 0.0,
                "last_order_date": None,
            },
        )

        locked_until = as_aware(account.locked_until)
        last_login_at = as_aware(account.last_login_at)
        updated_at = as_aware(account.updated_at)
        last_active = last_login_at or updated_at
        is_online = bool(
            last_active
            and (now - last_active) <= timedelta(minutes=5)
        )

        items.append(
            {
                "id": account.id,
                "customer_name": account.customer_name,
                "phone": account.phone,
                "customer_phone": account.phone,
                "phone_verified": bool(account.phone_verified),
                "customer_email": google_email or None,
                "email": google_email or None,
                "email_verified": bool(google_session and google_email),
                "auth_provider": "google" if google_session else "phone_pin",
                "google_verified": bool(google_session and google_email),
                "is_locked": bool(
                    locked_until and locked_until > now
                ),
                "locked_until": iso(locked_until),
                "failed_login_attempts": int(
                    account.failed_login_attempts or 0
                ),
                "last_login_at": iso(last_login_at),
                "created_at": iso(account.created_at),
                "updated_at": iso(updated_at),
                "first_seen": iso(account.created_at),
                "last_active": iso(last_active),
                "is_online": is_online,
                "is_guest": False,
                "total_orders": int(
                    order_stats["total_orders"] or 0
                ),
                "total_spent": round(
                    float(order_stats["total_spent"] or 0),
                    2,
                ),
                "last_order_date": iso(
                    order_stats["last_order_date"]
                ),
            }
        )

    return {
        "success": True,
        "items": items,
        "total": len(items),
        "online_count": sum(
            1 for item in items if item["is_online"]
        ),
    }


@router.post("/reset-pin")
async def reset_customer_pin(
    data: ResetCustomerPinRequest,
    _admin: None = Depends(require_fai_fai_admin_key),
    db: AsyncSession = Depends(get_db),
):
    phone = normalize_phone(data.phone)
    new_pin = validate_pin(data.new_pin)

    result = await db.execute(
        select(Customer_pin_accounts_v2).where(
            Customer_pin_accounts_v2.phone == phone
        )
    )
    account = result.scalar_one_or_none()

    if account is None:
        tail = phone_key(phone)
        fallback_result = await db.execute(
            select(Customer_pin_accounts_v2)
            .where(Customer_pin_accounts_v2.phone.ilike(f"%{tail}"))
            .order_by(desc(Customer_pin_accounts_v2.id))
            .limit(1)
        )
        account = fallback_result.scalar_one_or_none()

    if account is None:
        raise HTTPException(
            status_code=404,
            detail="Registered customer account was not found",
        )

    pin_hash, pin_salt = hash_pin(new_pin)

    account.pin_hash = pin_hash
    account.pin_salt = pin_salt
    account.failed_login_attempts = 0
    account.locked_until = None
    account.updated_at = utc_now()

    try:
        await db.commit()
        await db.refresh(account)
    except Exception:
        await db.rollback()
        logger.exception("Customer PIN reset failed")
        raise HTTPException(
            status_code=500,
            detail="Could not reset customer PIN",
        )

    return {
        "success": True,
        "message": "Customer PIN reset successfully",
        "customer": {
            "id": account.id,
            "customer_name": account.customer_name,
            "phone": account.phone,
            "updated_at": iso(account.updated_at),
        },
    }
