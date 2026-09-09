import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status
from jose import JWTError, jwt
from pydantic import BaseModel, Field
from sqlalchemy import delete, desc, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from models.customer_pin_accounts_v2 import Customer_pin_accounts_v2
from models.customer_sessions import Customer_sessions
from models.orders import Orders

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/customer-auth", tags=["customer-auth"])

PIN_ITERATIONS = 310_000
PIN_LOCK_AFTER_ATTEMPTS = 5
PIN_LOCK_MINUTES = 15
TOKEN_DAYS = 90
JWT_ALGORITHM = "HS256"


class PhoneRequest(BaseModel):
    phone: str


class LoginRequest(BaseModel):
    phone: Optional[str] = None
    customer_phone: Optional[str] = None
    pin: str = Field(min_length=4, max_length=4)


class SignupRequest(BaseModel):
    name: Optional[str] = None
    customer_name: Optional[str] = None
    phone: Optional[str] = None
    customer_phone: Optional[str] = None
    pin: str = Field(min_length=4, max_length=4)
    # Kept optional only so an older frontend cannot crash during deployment.
    code: Optional[str] = None


class GoogleLoginRequest(BaseModel):
    credential: str = Field(min_length=20)


class GoogleCompleteRequest(BaseModel):
    signup_token: str = Field(min_length=20)
    phone: str
    pin: str = Field(min_length=4, max_length=4)


class ChangePinRequest(BaseModel):
    phone: Optional[str] = None
    customer_phone: Optional[str] = None
    current_pin: Optional[str] = None
    old_pin: Optional[str] = None
    new_pin: str = Field(min_length=4, max_length=4)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


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
            detail="Use mobile number with country code, for example +971501234567",
        )

    if not re.fullmatch(r"\+[1-9]\d{7,14}", normalized):
        raise HTTPException(status_code=400, detail="Invalid mobile number")

    return normalized


def validate_pin(pin: str, field_name: str = "PIN") -> str:
    value = (pin or "").strip()
    if not re.fullmatch(r"\d{4}", value):
        raise HTTPException(status_code=400, detail=f"{field_name} must be exactly 4 digits")
    return value


def hash_pin(pin: str, salt_bytes: Optional[bytes] = None) -> tuple[str, str]:
    salt = salt_bytes or secrets.token_bytes(16)
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


def verify_pin(pin: str, stored_hash: str, stored_salt: str) -> bool:
    try:
        salt = base64.urlsafe_b64decode(stored_salt.encode("ascii"))
        candidate_hash, _ = hash_pin(pin, salt)
        return hmac.compare_digest(candidate_hash, stored_hash)
    except Exception:
        return False




def get_google_client_id() -> str:
    value = (os.getenv("GOOGLE_CLIENT_ID") or "").strip()
    if not value:
        raise HTTPException(
            status_code=503,
            detail="Google Sign-In is not configured yet",
        )
    return value


async def verify_google_credential(credential: str) -> dict:
    token = (credential or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Google credential is missing")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://oauth2.googleapis.com/tokeninfo",
                params={"id_token": token},
            )
    except httpx.HTTPError:
        logger.exception("Google token verification request failed")
        raise HTTPException(
            status_code=503,
            detail="Could not verify Google account right now. Please try again",
        )

    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google sign-in")

    payload = response.json()
    if payload.get("aud") != get_google_client_id():
        raise HTTPException(status_code=401, detail="Google account is for a different app")

    if str(payload.get("email_verified", "")).lower() not in {"true", "1"}:
        raise HTTPException(status_code=401, detail="Google email is not verified")

    issuer = str(payload.get("iss") or "")
    if issuer not in {"accounts.google.com", "https://accounts.google.com"}:
        raise HTTPException(status_code=401, detail="Invalid Google issuer")

    sub = str(payload.get("sub") or "").strip()
    email = str(payload.get("email") or "").strip().lower()
    name = str(payload.get("name") or payload.get("given_name") or "Customer").strip()

    if not sub or not email:
        raise HTTPException(status_code=401, detail="Google account details are incomplete")

    return {
        "sub": sub,
        "email": email,
        "name": name or "Customer",
        "picture": str(payload.get("picture") or "").strip(),
    }


def create_google_signup_token(profile: dict) -> str:
    now = utc_now()
    payload = {
        "sub": str(profile["sub"]),
        "email": str(profile["email"]),
        "name": str(profile.get("name") or "Customer"),
        "token_type": "google_signup",
        "iat": now,
        "exp": now + timedelta(minutes=10),
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)


def decode_google_signup_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Google sign-in expired. Please try again")

    if payload.get("token_type") != "google_signup":
        raise HTTPException(status_code=401, detail="Invalid Google sign-in session")
    return payload


async def find_google_session(db: AsyncSession, google_sub: str) -> Optional[Customer_sessions]:
    result = await db.execute(
        select(Customer_sessions).where(Customer_sessions.user_id == f"google:{google_sub}")
    )
    return result.scalar_one_or_none()


async def find_google_session_by_phone(db: AsyncSession, phone: str) -> Optional[Customer_sessions]:
    tail = phone[-9:]
    result = await db.execute(
        select(Customer_sessions)
        .where(Customer_sessions.user_id.ilike("google:%"))
        .where(Customer_sessions.customer_phone.ilike(f"%{tail}"))
        .order_by(desc(Customer_sessions.id))
        .limit(1)
    )
    return result.scalar_one_or_none()


def attach_google_identity(customer: dict, google_session: Optional[Customer_sessions]) -> dict:
    if google_session:
        customer["email"] = google_session.customer_email
        customer["customer_email"] = google_session.customer_email
        customer["email_verified"] = True
        customer["auth_provider"] = "google"
    else:
        customer["email"] = None
        customer["customer_email"] = None
        customer["email_verified"] = False
        customer["auth_provider"] = "phone_pin"
    return customer


def get_jwt_secret() -> str:
    value = (os.getenv("CUSTOMER_JWT_SECRET") or os.getenv("JWT_SECRET_KEY") or "").strip()
    if len(value) < 24:
        raise HTTPException(
            status_code=500,
            detail="Customer JWT secret is not configured on Render",
        )
    return value


def create_customer_token(account: Customer_pin_accounts_v2) -> str:
    now = utc_now()
    payload = {
        "sub": str(account.id),
        "phone": account.phone,
        "customer_name": account.customer_name,
        "token_type": "customer",
        "iat": now,
        "exp": now + timedelta(days=TOKEN_DAYS),
    }
    return jwt.encode(payload, get_jwt_secret(), algorithm=JWT_ALGORITHM)


def get_bearer_token(authorization: Optional[str]) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="Customer login required")
    parts = authorization.strip().split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(status_code=401, detail="Invalid customer token")
    return parts[1].strip()


def decode_customer_token(token: str) -> dict:
    try:
        payload = jwt.decode(token, get_jwt_secret(), algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status_code=401, detail="Customer session expired. Please login again")

    if payload.get("token_type") != "customer":
        raise HTTPException(status_code=401, detail="Invalid customer token")
    return payload


async def find_account(db: AsyncSession, phone: str) -> Optional[Customer_pin_accounts_v2]:
    result = await db.execute(
        select(Customer_pin_accounts_v2).where(Customer_pin_accounts_v2.phone == phone)
    )
    return result.scalar_one_or_none()


async def find_legacy_customer(db: AsyncSession, phone: str) -> Optional[Customer_sessions]:
    tail = phone[-9:]
    result = await db.execute(
        select(Customer_sessions)
        .where(Customer_sessions.customer_phone.ilike(f"%{tail}"))
        .order_by(desc(Customer_sessions.id))
        .limit(1)
    )
    return result.scalar_one_or_none()


async def ensure_customer_session(db: AsyncSession, phone: str, name: str) -> None:
    existing = await find_legacy_customer(db, phone)
    if existing:
        existing.customer_phone = phone
        if name:
            existing.customer_name = name
        existing.last_active = utc_now()
        return

    db.add(
        Customer_sessions(
            user_id=f"customer:{uuid4().hex}",
            customer_name=name or "Customer",
            customer_phone=phone,
            first_seen=utc_now(),
            last_active=utc_now(),
        )
    )


def auth_response(account: Customer_pin_accounts_v2, google_session: Optional[Customer_sessions] = None) -> dict:
    token = create_customer_token(account)
    customer = {
        "id": account.id,
        "name": account.customer_name,
        "customer_name": account.customer_name,
        "phone": account.phone,
        "customer_phone": account.phone,
        "phone_verified": bool(account.phone_verified),
    }
    attach_google_identity(customer, google_session)
    return {
        "access_token": token,
        "token": token,
        "token_type": "bearer",
        "customer": customer,
        "user": customer,
    }


def normalize_locked_until(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


async def create_account(data: SignupRequest, db: AsyncSession) -> dict:
    name = (data.name or data.customer_name or "").strip()
    phone = normalize_phone(data.phone or data.customer_phone or "")
    pin = validate_pin(data.pin)

    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Please enter your full name")

    existing_account = await find_account(db, phone)
    if existing_account:
        raise HTTPException(
            status_code=409,
            detail="An account already exists for this mobile number. Please login",
        )

    # Old customer/order records are linked instead of being deleted or duplicated.
    legacy = await find_legacy_customer(db, phone)
    if legacy and (legacy.customer_name or "").strip():
        saved_name = (legacy.customer_name or "").strip()
        if not name:
            name = saved_name

    pin_hash, pin_salt = hash_pin(pin)
    account = Customer_pin_accounts_v2(
        phone=phone,
        customer_name=name,
        pin_hash=pin_hash,
        pin_salt=pin_salt,
        # OTP is removed, so do not claim the number was SMS-verified.
        phone_verified=False,
    )
    db.add(account)
    await ensure_customer_session(db, phone, name)

    try:
        await db.commit()
        await db.refresh(account)
    except Exception:
        await db.rollback()
        logger.exception("Could not create customer account")
        raise HTTPException(status_code=500, detail="Could not create account")

    return auth_response(account)


@router.post("/account-status")
async def account_status(data: PhoneRequest, db: AsyncSession = Depends(get_db)):
    phone = normalize_phone(data.phone)
    account = await find_account(db, phone)
    legacy = None if account else await find_legacy_customer(db, phone)
    return {
        # Only a secure PIN account counts as an existing login account.
        "exists": bool(account),
        "secure_pin_active": bool(account),
        "legacy_customer_found": bool(legacy),
        "can_signup": not bool(account),
        "phone": phone,
    }


@router.post("/signup", status_code=status.HTTP_201_CREATED)
async def signup(data: SignupRequest, db: AsyncSession = Depends(get_db)):
    return await create_account(data, db)


@router.post("/signup-verify", status_code=status.HTTP_201_CREATED)
async def signup_verify_compatibility(data: SignupRequest, db: AsyncSession = Depends(get_db)):
    """Temporary compatibility endpoint while the frontend deployment updates."""
    return await create_account(data, db)


@router.post("/send-otp")
async def otp_removed():
    raise HTTPException(
        status_code=410,
        detail="OTP has been removed. Create an account directly with mobile number and PIN",
    )


@router.post("/login")
async def login(data: LoginRequest, db: AsyncSession = Depends(get_db)):
    phone = normalize_phone(data.phone or data.customer_phone or "")
    pin = validate_pin(data.pin)
    account = await find_account(db, phone)

    if not account:
        legacy = await find_legacy_customer(db, phone)
        if legacy:
            raise HTTPException(
                status_code=404,
                detail="No PIN account exists yet. Please use Sign Up once with this mobile number",
            )
        raise HTTPException(status_code=401, detail="Invalid mobile number or PIN")

    now = utc_now()
    locked_until = normalize_locked_until(account.locked_until)
    if locked_until and locked_until > now:
        raise HTTPException(
            status_code=429,
            detail="Too many wrong attempts. Try again after 15 minutes",
        )

    if not verify_pin(pin, account.pin_hash, account.pin_salt):
        account.failed_login_attempts = int(account.failed_login_attempts or 0) + 1
        if account.failed_login_attempts >= PIN_LOCK_AFTER_ATTEMPTS:
            account.locked_until = now + timedelta(minutes=PIN_LOCK_MINUTES)
            account.failed_login_attempts = 0
        await db.commit()
        raise HTTPException(status_code=401, detail="Invalid mobile number or PIN")

    account.failed_login_attempts = 0
    account.locked_until = None
    account.last_login_at = now
    account.updated_at = now
    await ensure_customer_session(db, phone, account.customer_name)
    await db.commit()
    await db.refresh(account)

    return auth_response(account)




@router.post("/google-login")
async def google_login(data: GoogleLoginRequest, db: AsyncSession = Depends(get_db)):
    profile = await verify_google_credential(data.credential)
    google_session = await find_google_session(db, profile["sub"])

    if google_session and (google_session.customer_phone or "").strip():
        try:
            phone = normalize_phone(google_session.customer_phone or "")
        except HTTPException:
            phone = ""

        if phone:
            account = await find_account(db, phone)
            if account:
                account.last_login_at = utc_now()
                account.updated_at = utc_now()
                google_session.customer_name = profile["name"] or account.customer_name
                google_session.customer_email = profile["email"]
                google_session.customer_phone = phone
                google_session.last_active = utc_now()
                await db.commit()
                await db.refresh(account)
                return {
                    **auth_response(account, google_session),
                    "needs_phone": False,
                }

    return {
        "needs_phone": True,
        "google_signup_token": create_google_signup_token(profile),
        "google_profile": {
            "name": profile["name"],
            "email": profile["email"],
        },
    }


@router.post("/google-complete")
async def google_complete(data: GoogleCompleteRequest, db: AsyncSession = Depends(get_db)):
    profile = decode_google_signup_token(data.signup_token)
    phone = normalize_phone(data.phone)
    pin = validate_pin(data.pin)
    google_sub = str(profile.get("sub") or "").strip()
    email = str(profile.get("email") or "").strip().lower()
    name = str(profile.get("name") or "Customer").strip() or "Customer"

    if not google_sub or not email:
        raise HTTPException(status_code=401, detail="Google sign-in session is invalid")

    google_session = await find_google_session(db, google_sub)
    existing_account = await find_account(db, phone)

    # Keep one stable Google identity per Fai Fai phone account. This prevents
    # accidental/repeated linking from moving a Google identity to another phone.
    if google_session and (google_session.customer_phone or '').strip():
        linked_phone = normalize_phone(google_session.customer_phone or '')
        if linked_phone != phone:
            raise HTTPException(
                status_code=409,
                detail='This Google account is already linked to another Fai Fai account',
            )

    google_for_phone = await find_google_session_by_phone(db, phone)
    if google_for_phone and google_for_phone.user_id != f"google:{google_sub}":
        raise HTTPException(
            status_code=409,
            detail='This mobile number is already linked to another Google account',
        )

    if existing_account:
        if not verify_pin(pin, existing_account.pin_hash, existing_account.pin_salt):
            raise HTTPException(
                status_code=401,
                detail="This mobile number already has an account. Enter its correct 4-digit PIN to link Google",
            )
        account = existing_account
    else:
        pin_hash, pin_salt = hash_pin(pin)
        account = Customer_pin_accounts_v2(
            phone=phone,
            customer_name=name,
            pin_hash=pin_hash,
            pin_salt=pin_salt,
            phone_verified=False,
        )
        db.add(account)
        await db.flush()

    if google_session:
        google_session.customer_name = name or account.customer_name
        google_session.customer_email = email
        google_session.customer_phone = phone
        google_session.last_active = utc_now()
    else:
        google_session = Customer_sessions(
            user_id=f"google:{google_sub}",
            customer_name=name or account.customer_name,
            customer_email=email,
            customer_phone=phone,
            first_seen=utc_now(),
            last_active=utc_now(),
        )
        db.add(google_session)

    account.last_login_at = utc_now()
    account.updated_at = utc_now()
    await ensure_customer_session(db, phone, account.customer_name)

    try:
        await db.commit()
        await db.refresh(account)
    except Exception:
        await db.rollback()
        logger.exception("Could not finish Google customer sign-in")
        raise HTTPException(status_code=500, detail="Could not finish Google sign-in")

    return {
        **auth_response(account, google_session),
        "needs_phone": False,
    }


@router.post("/change-pin")
async def change_pin(
    data: ChangePinRequest,
    authorization: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    raw_phone = (data.phone or data.customer_phone or "").strip()
    account: Optional[Customer_pin_accounts_v2] = None

    if raw_phone:
        phone = normalize_phone(raw_phone)
        account = await find_account(db, phone)
    else:
        token = get_bearer_token(authorization)
        payload = decode_customer_token(token)
        try:
            account_id = int(payload.get("sub", ""))
        except (TypeError, ValueError):
            raise HTTPException(status_code=401, detail="Invalid customer token")
        result = await db.execute(
            select(Customer_pin_accounts_v2).where(Customer_pin_accounts_v2.id == account_id)
        )
        account = result.scalar_one_or_none()

    current_pin = validate_pin(data.current_pin or data.old_pin or "", "Current PIN")
    new_pin = validate_pin(data.new_pin, "New PIN")

    if current_pin == new_pin:
        raise HTTPException(status_code=400, detail="New PIN must be different from current PIN")

    if not account or not verify_pin(current_pin, account.pin_hash, account.pin_salt):
        raise HTTPException(status_code=401, detail="Current PIN is incorrect")

    pin_hash, pin_salt = hash_pin(new_pin)
    account.pin_hash = pin_hash
    account.pin_salt = pin_salt
    account.failed_login_attempts = 0
    account.locked_until = None
    account.updated_at = utc_now()
    await db.commit()

    return {"message": "PIN changed successfully"}


@router.post("/forgot-pin-reset")
async def forgot_pin_reset_removed():
    raise HTTPException(
        status_code=410,
        detail="For security, contact Fai Fai Juice to reset a forgotten PIN",
    )


@router.delete("/delete-account")
async def delete_customer_account(
    authorization: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    """Delete login identity and personal profile data while preserving anonymized order totals."""
    token = get_bearer_token(authorization)
    payload = decode_customer_token(token)

    try:
        account_id = int(payload.get("sub", ""))
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid customer token")

    result = await db.execute(
        select(Customer_pin_accounts_v2).where(Customer_pin_accounts_v2.id == account_id)
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=404, detail="Customer account not found")

    phone = account.phone
    phone_tail = phone[-9:]
    deleted_user = f"deleted:{account.id}"

    # Keep financial/order history but remove customer-identifying delivery details.
    await db.execute(
        update(Orders)
        .where(Orders.customer_phone.ilike(f"%{phone_tail}"))
        .values(
            user_id=deleted_user,
            customer_name="Deleted Customer",
            customer_phone="Deleted",
            customer_address="",
            customer_lat=None,
            customer_lng=None,
        )
    )

    # Remove all customer session rows for this phone, including a linked Google identity.
    sessions = await db.execute(
        select(Customer_sessions).where(Customer_sessions.customer_phone.ilike(f"%{phone_tail}"))
    )
    for row in sessions.scalars().all():
        await db.delete(row)

    await db.delete(account)

    try:
        await db.commit()
    except Exception:
        await db.rollback()
        logger.exception("Could not delete customer account")
        raise HTTPException(status_code=500, detail="Could not delete account")

    return {"success": True, "message": "Account deleted successfully"}


@router.get("/me")
async def me(
    authorization: Optional[str] = Header(default=None),
    db: AsyncSession = Depends(get_db),
):
    token = get_bearer_token(authorization)
    payload = decode_customer_token(token)

    try:
        account_id = int(payload.get("sub", ""))
    except (TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Invalid customer token")

    result = await db.execute(
        select(Customer_pin_accounts_v2).where(Customer_pin_accounts_v2.id == account_id)
    )
    account = result.scalar_one_or_none()
    if not account:
        raise HTTPException(status_code=401, detail="Customer account not found")

    google_session = await find_google_session_by_phone(db, account.phone)
    return auth_response(account, google_session)
