# @File: backend/routers/ziina_payments.py
# @Desc: Secure Ziina hosted online-card payment integration for Fai Fai Juice.

import hashlib
import hmac
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from models.orders import Orders
from routers.customer_auth import decode_customer_token, get_bearer_token
from routers.fai_fai_admin_control import AdminIdentity, get_current_admin
from services.rider_assignment import auto_assign_order, cancel_order_assignments

router = APIRouter(prefix="/api/v1/ziina", tags=["ziina-payments"])

ZIINA_API_BASE = "https://api-v2.ziina.com/api"
ZIINA_INTENT_MARKER = "Ziina Payment Intent:"
ZIINA_REFUND_MARKER = "Ziina Refund:"
ZIINA_ABANDONED_MARKER = "Ziina Payment Abandoned:"
ZIINA_FEE_MARKER = "Ziina Fee:"
ACTIVE_STATUSES = {"requires_payment_instrument", "requires_user_action", "pending"}
FAILED_STATUSES = {"failed", "canceled", "cancelled"}


def env_bool(name: str, default: bool = False) -> bool:
    raw = str(os.getenv(name, "")).strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


def api_key() -> str:
    value = str(os.getenv("ZIINA_API_KEY", "")).strip()
    if not value:
        raise HTTPException(status_code=503, detail="Ziina API key is not configured")
    return value


def public_frontend_url() -> str:
    # FRONTEND_URL should be the public Fai Fai customer URL on Render.
    return str(os.getenv("FRONTEND_URL", "https://fai-fai-juice.pages.dev")).strip().rstrip("/")


def order_amount_fils(order: Orders) -> int:
    amount = int(round(float(order.total_amount or 0) * 100))
    if amount < 200:
        raise HTTPException(status_code=400, detail="Online payment minimum is AED 2")
    return amount


def marker(intent_id: str) -> str:
    return f"{ZIINA_INTENT_MARKER} {intent_id}"


def latest_intent_id(order: Orders) -> str:
    notes = str(order.order_notes or "")
    matches = re.findall(r"Ziina Payment Intent:\s*([A-Za-z0-9_-]+)", notes)
    return matches[-1] if matches else ""


def latest_refund_record(order: Orders) -> dict[str, Any] | None:
    notes = str(order.order_notes or "")
    matches = re.findall(
        r"Ziina Refund:\s*([0-9A-Fa-f-]{36});status=([a-z_]+);amount=(\d+)",
        notes,
        flags=re.IGNORECASE,
    )
    if not matches:
        return None
    refund_id, status, amount = matches[-1]
    return {
        "id": refund_id,
        "status": status.lower(),
        "amount": int(amount),
    }


def refund_marker(refund_id: str, status: str, amount: int) -> str:
    return (
        f"{ZIINA_REFUND_MARKER} {refund_id};"
        f"status={status.lower()};amount={int(amount)}"
    )


def append_note(existing: Optional[str], new_note: str) -> str:
    current = str(existing or "").strip()
    if new_note in current:
        return current
    return f"{current} | {new_note}".strip(" |")




def ziina_fee_marker(amount_fils: int) -> str:
    return f"{ZIINA_FEE_MARKER} {max(0, int(amount_fils))}"


def set_ziina_fee_note(existing: Optional[str], amount_fils: Any) -> str:
    """Store the latest Ziina fee in fils without exposing it as a customer note."""
    try:
        fee_fils = max(0, int(amount_fils or 0))
    except (TypeError, ValueError):
        fee_fils = 0

    current = str(existing or "").strip()
    parts = [part.strip() for part in current.split("|") if part.strip()]
    parts = [
        part
        for part in parts
        if not re.match(r"^Ziina Fee:\s*\d+$", part, flags=re.IGNORECASE)
    ]
    parts.append(ziina_fee_marker(fee_fils))
    return " | ".join(parts)


def abandoned_marker() -> str:
    return f"{ZIINA_ABANDONED_MARKER} {datetime.now(timezone.utc).isoformat()}"


def is_abandoned_payment(order: Orders) -> bool:
    payment = str(order.payment_method or "").strip().lower()
    notes = str(order.order_notes or "").lower()
    return "abandoned" in payment or ZIINA_ABANDONED_MARKER.lower() in notes


def is_delivery_order(order: Orders) -> bool:
    explicit = str(getattr(order, "order_type", "") or "").strip().lower()
    notes = str(getattr(order, "order_notes", "") or "").lower()
    return explicit == "delivery" or "order type: delivery" in notes or "delivery address:" in notes


def customer_user_id(authorization: Optional[str]) -> str:
    payload = decode_customer_token(get_bearer_token(authorization))
    subject = str(payload.get("sub") or "").strip()
    if not subject:
        raise HTTPException(status_code=401, detail="Customer login required")
    return f"customer:{subject}"


async def owned_order(
    db: AsyncSession,
    order_id: int,
    authorization: Optional[str],
) -> Orders:
    owner_id = customer_user_id(authorization)
    result = await db.execute(
        select(Orders).where(Orders.id == order_id, Orders.user_id == owner_id)
    )
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return order


async def ziina_request(
    method: str,
    path: str,
    *,
    payload: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    headers = {
        "Authorization": f"Bearer {api_key()}",
        "Accept": "application/json",
    }
    if payload is not None:
        headers["Content-Type"] = "application/json"

    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            response = await client.request(
                method,
                f"{ZIINA_API_BASE}{path}",
                headers=headers,
                json=payload,
            )
    except httpx.RequestError as exc:
        logging.exception("Ziina network request failed")
        raise HTTPException(
            status_code=502,
            detail="Could not connect to Ziina. Please try again.",
        ) from exc

    try:
        body = response.json()
    except Exception:
        body = {"message": response.text[:500]}

    if response.status_code >= 400:
        detail = None
        if isinstance(body, dict):
            latest_error = body.get("latest_error")
            if isinstance(latest_error, dict):
                detail = latest_error.get("message")
            detail = detail or body.get("detail") or body.get("message")
        logging.error("Ziina API error %s %s: %s", method, path, body)
        raise HTTPException(
            status_code=502,
            detail=str(detail or f"Ziina returned HTTP {response.status_code}"),
        )

    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="Unexpected response from Ziina")
    return body


async def release_paid_order(
    db: AsyncSession,
    order: Orders,
    intent: dict[str, Any],
) -> str:
    """Verify Ziina result and only then release the order to the shop."""
    status = str(intent.get("status") or "").strip().lower()
    intent_id = str(intent.get("id") or "").strip()

    if not intent_id or marker(intent_id) not in str(order.order_notes or ""):
        raise HTTPException(status_code=400, detail="Payment does not belong to this order")

    if int(intent.get("amount") or 0) != order_amount_fils(order):
        raise HTTPException(status_code=400, detail="Payment amount does not match order total")

    if str(intent.get("currency_code") or "AED").upper() != "AED":
        raise HTTPException(status_code=400, detail="Unexpected payment currency")

    current_status = str(order.status or "").strip().lower()

    if status == "completed":
        # Ziina returns the real provider fee in fils. Keep it with the order so
        # Admin Finance can show the exact settlement fee instead of guessing.
        # This is internal-only metadata; public_order_notes() removes it.
        previous_notes = str(order.order_notes or "")
        order.order_notes = set_ziina_fee_note(
            order.order_notes,
            intent.get("fee_amount"),
        )
        fee_note_changed = str(order.order_notes or "") != previous_notes

        if current_status == "payment_pending":
            order.status = "new"
            order.payment_method = "Ziina Online (Paid)"
            # Kitchen timer starts after successful payment, not while customer is paying.
            try:
                order.created_at = datetime.now(timezone.utc)
            except Exception:
                pass
            await db.commit()
            await db.refresh(order)

            # Delivery rider assignment also waits until payment is confirmed.
            if is_delivery_order(order):
                try:
                    await auto_assign_order(db, order)
                except Exception:
                    logging.exception("Auto rider assignment failed after Ziina payment for order %s", order.id)
                    await db.rollback()
        elif fee_note_changed:
            # Verification/webhook can run again after the order has already been
            # released. Persist the final fee even when status is no longer pending.
            await db.commit()
            await db.refresh(order)

        elif current_status == "cancelled" and is_abandoned_payment(order):
            # The customer switched away from this hosted checkout (for example to Cash).
            # Ziina does not expose a payment-intent cancellation endpoint in its
            # public API, so if an abandoned payment later completes, refund it
            # automatically instead of releasing a duplicate order to Kitchen.
            return await refund_abandoned_payment(db, order, intent)

    elif status in FAILED_STATUSES:
        if current_status == "payment_pending":
            order.status = "cancelled"
            order.payment_method = "Ziina Online (Failed/Cancelled)"
            await db.commit()

    return status


class OrderPaymentRequest(BaseModel):
    order_id: int = Field(ge=1)


class AdminRefundRequest(BaseModel):
    order_id: int = Field(ge=1)
    reason: str = Field(min_length=2, max_length=300)


async def admin_owned_order(
    db: AsyncSession,
    order_id: int,
    identity: AdminIdentity,
) -> Orders:
    if identity.role != "super_admin" and not identity.permissions.get("orders"):
        raise HTTPException(status_code=403, detail="Orders permission required")

    result = await db.execute(select(Orders).where(Orders.id == order_id))
    order = result.scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")

    if (
        identity.role != "super_admin"
        and identity.branch_id is not None
        and int(getattr(order, "branch_id", 0) or 0) != int(identity.branch_id)
    ):
        raise HTTPException(status_code=403, detail="This order belongs to another branch")

    return order


async def apply_refund_state(
    db: AsyncSession,
    order: Orders,
    refund: dict[str, Any],
) -> dict[str, Any]:
    refund_id = str(refund.get("id") or "").strip()
    status = str(refund.get("status") or "pending").strip().lower()
    amount = int(refund.get("amount") or 0)
    if not refund_id:
        raise HTTPException(status_code=502, detail="Ziina refund ID was not returned")

    order.order_notes = append_note(
        order.order_notes,
        refund_marker(refund_id, status, amount),
    )

    # Preserve the original completion timestamp before any refund update can
    # move updated_at and accidentally shift an old sale into today's report.
    if getattr(order, "delivered_at", None) is None and str(order.status or "").lower() == "completed":
        order.delivered_at = order.updated_at or order.created_at

    if status == "completed":
        order.payment_method = "Ziina Online (Refunded)"
        order.status = "cancelled"
        await cancel_order_assignments(db, order.id)
    elif status == "pending":
        order.payment_method = "Ziina Online (Refund Pending)"
    elif status == "failed":
        order.payment_method = "Ziina Online (Refund Failed)"

    await db.commit()
    await db.refresh(order)

    return {
        "success": status != "failed",
        "order_id": order.id,
        "refund_id": refund_id,
        "status": status,
        "amount": amount,
        "amount_aed": round(amount / 100, 2),
        "order_status": order.status,
    }


async def refund_abandoned_payment(
    db: AsyncSession,
    order: Orders,
    intent: dict[str, Any],
) -> str:
    """Refund a Ziina payment that completed after the customer switched away.

    The order stays cancelled so a late payment can never create a second
    Kitchen order. If the refund API temporarily fails, keep a clear marker so
    Admin can use the existing manual refund control.
    """
    intent_id = str(intent.get("id") or "").strip()
    if not intent_id:
        raise HTTPException(status_code=502, detail="Ziina payment reference is missing")

    existing = latest_refund_record(order)
    try:
        if existing and existing["status"] in {"pending", "completed"}:
            refund = await ziina_request("GET", f"/refund/{existing['id']}")
        else:
            refund_id = str(uuid.uuid4())
            refund = await ziina_request(
                "POST",
                "/refund",
                payload={
                    "id": refund_id,
                    "payment_intent_id": intent_id,
                    "amount": order_amount_fils(order),
                    "currency_code": "AED",
                    "test": env_bool("ZIINA_TEST_MODE", True),
                },
            )
        result = await apply_refund_state(db, order, refund)
        refund_status = str(result.get("status") or "pending").lower()
        return "refunded" if refund_status == "completed" else f"refund_{refund_status}"
    except HTTPException:
        logging.exception("Automatic refund failed for abandoned Ziina order %s", order.id)
        order.status = "cancelled"
        order.payment_method = "Ziina Online (Abandoned - Refund Needed)"
        order.order_notes = append_note(order.order_notes, "Automatic refund needs Admin review")
        await db.commit()
        return "refund_needed"


async def prepare_pending_order_for_offline_switch(
    db: AsyncSession,
    order: Orders,
) -> dict[str, Any]:
    """Safely supersede an unpaid Ziina checkout before creating Cash/Card order.

    If Ziina already completed, the paid order wins and no second order should be
    created. If the payment is failed/cancelled, the pending DB row is closed.
    If it is still active, mark it abandoned; a later completion is auto-refunded
    by release_paid_order/webhook and can never be released to Kitchen.
    """
    if str(order.status or "").strip().lower() != "payment_pending":
        return {"safe_to_switch": True, "paid": False, "status": order.status}
    if not str(order.payment_method or "").strip().lower().startswith("ziina online"):
        return {"safe_to_switch": True, "paid": False, "status": order.status}

    intent_id = latest_intent_id(order)
    if not intent_id:
        order.status = "cancelled"
        order.payment_method = "Ziina Online (Abandoned)"
        order.order_notes = append_note(order.order_notes, abandoned_marker())
        await db.commit()
        return {"safe_to_switch": True, "paid": False, "status": "cancelled"}

    # Do not create a Cash order until we know the old hosted checkout was not
    # already paid. This avoids a double order/double payment on slow redirects.
    intent = await ziina_request("GET", f"/payment_intent/{intent_id}")
    provider_status = str(intent.get("status") or "").strip().lower()

    if provider_status == "completed":
        status = await release_paid_order(db, order, intent)
        return {
            "safe_to_switch": False,
            "paid": status == "completed",
            "status": status,
            "order_id": order.id,
        }

    if provider_status in FAILED_STATUSES:
        status = await release_paid_order(db, order, intent)
        return {"safe_to_switch": True, "paid": False, "status": status}

    if provider_status in ACTIVE_STATUSES:
        order.status = "cancelled"
        order.payment_method = "Ziina Online (Abandoned)"
        order.order_notes = append_note(order.order_notes, abandoned_marker())
        await db.commit()
        return {"safe_to_switch": True, "paid": False, "status": "abandoned"}

    raise HTTPException(
        status_code=409,
        detail="Could not confirm the previous online payment status. Please try again.",
    )


@router.get("/config")
async def get_ziina_config():
    # Never expose the API key to browser/mobile clients.
    return {
        "enabled": env_bool("ZIINA_PAYMENT_ENABLED", False),
        "test_mode": env_bool("ZIINA_TEST_MODE", True),
        "provider": "Ziina",
    }


@router.post("/create-payment")
async def create_payment(
    data: OrderPaymentRequest,
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    if not env_bool("ZIINA_PAYMENT_ENABLED", False):
        raise HTTPException(status_code=503, detail="Online payment is currently disabled")

    order = await owned_order(db, data.order_id, authorization)

    if not str(order.payment_method or "").strip().lower().startswith("ziina online"):
        raise HTTPException(status_code=400, detail="This order is not an online-payment order")

    current_status = str(order.status or "").strip().lower()
    if current_status == "new" and "ziina online (paid)" in str(order.payment_method or "").lower():
        return {"success": True, "already_paid": True, "order_id": order.id, "status": "completed"}
    if current_status != "payment_pending":
        raise HTTPException(status_code=400, detail=f"Order cannot start payment in status '{order.status}'")

    # Reuse the most recent still-active intent instead of creating duplicate payment pages.
    previous_id = latest_intent_id(order)
    if previous_id:
        try:
            previous = await ziina_request("GET", f"/payment_intent/{previous_id}")
            previous_status = str(previous.get("status") or "").strip().lower()
            if previous_status == "completed":
                await release_paid_order(db, order, previous)
                return {"success": True, "already_paid": True, "order_id": order.id, "status": "completed"}
            if previous_status in ACTIVE_STATUSES and str(previous.get("redirect_url") or "").strip():
                return {
                    "success": True,
                    "order_id": order.id,
                    "payment_intent_id": previous_id,
                    "redirect_url": str(previous.get("redirect_url")),
                    "status": previous_status,
                    "test_mode": env_bool("ZIINA_TEST_MODE", True),
                    "reused": True,
                }
        except HTTPException as exc:
            # Do NOT create a second hosted payment when an earlier intent exists
            # but cannot be verified. Two live payment links for one order could
            # let the customer pay twice. Retry verification instead.
            logging.warning("Could not verify previous Ziina intent for order %s", order.id)
            raise HTTPException(
                status_code=503,
                detail="Could not verify your existing online payment. Please try again in a moment.",
            ) from exc

    base = public_frontend_url()
    success_url = f"{base}/checkout?ziina=success&order_id={order.id}"
    cancel_url = f"{base}/checkout?ziina=cancel&order_id={order.id}"
    failure_url = f"{base}/checkout?ziina=failed&order_id={order.id}"

    # Expire abandoned hosted checkouts after 30 minutes.
    expiry_ms = int((datetime.now(timezone.utc) + timedelta(minutes=30)).timestamp() * 1000)

    payload = {
        "amount": order_amount_fils(order),
        "currency_code": "AED",
        "message": f"Fai Fai Juice - Order #{order.id}",
        "success_url": success_url,
        "cancel_url": cancel_url,
        "failure_url": failure_url,
        "test": env_bool("ZIINA_TEST_MODE", True),
        "expiry": str(expiry_ms),
        "allow_tips": False,
    }

    intent = await ziina_request("POST", "/payment_intent", payload=payload)
    intent_id = str(intent.get("id") or "").strip()
    redirect_url = str(intent.get("redirect_url") or "").strip()
    if not intent_id or not redirect_url:
        raise HTTPException(status_code=502, detail="Ziina did not return a valid payment link")

    order.order_notes = append_note(order.order_notes, marker(intent_id))
    if intent.get("fee_amount") is not None:
        order.order_notes = set_ziina_fee_note(
            order.order_notes,
            intent.get("fee_amount"),
        )
    await db.commit()

    return {
        "success": True,
        "order_id": order.id,
        "payment_intent_id": intent_id,
        "redirect_url": redirect_url,
        "status": intent.get("status"),
        "test_mode": env_bool("ZIINA_TEST_MODE", True),
    }


@router.post("/verify-payment")
async def verify_payment(
    data: OrderPaymentRequest,
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    order = await owned_order(db, data.order_id, authorization)
    intent_id = latest_intent_id(order)
    if not intent_id:
        raise HTTPException(status_code=400, detail="No Ziina payment was started for this order")

    intent = await ziina_request("GET", f"/payment_intent/{intent_id}")
    status = await release_paid_order(db, order, intent)
    return {
        "success": True,
        "order_id": order.id,
        "payment_intent_id": intent_id,
        "status": status,
        "paid": status == "completed",
    }


@router.post("/cancel-payment-order")
async def cancel_payment_order(
    data: OrderPaymentRequest,
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    order = await owned_order(db, data.order_id, authorization)

    if str(order.status or "").strip().lower() != "payment_pending":
        return {"success": True, "order_id": order.id, "status": order.status}

    intent_id = latest_intent_id(order)
    if intent_id:
        intent = await ziina_request("GET", f"/payment_intent/{intent_id}")
        provider_status = str(intent.get("status") or "").strip().lower()
        status = await release_paid_order(db, order, intent)
        if status == "completed":
            return {"success": True, "order_id": order.id, "status": "new", "paid": True}
        if provider_status in FAILED_STATUSES:
            return {"success": True, "order_id": order.id, "status": "cancelled", "paid": False}
        if provider_status in ACTIVE_STATUSES:
            # Ziina's public Payment Intent API has no server-side cancel endpoint.
            # Keep the DB order pending instead of pretending it was cancelled;
            # this prevents a later successful charge from being silently lost.
            return {
                "success": False,
                "order_id": order.id,
                "status": "payment_pending",
                "payment_status": provider_status,
                "redirect_url": str(intent.get("redirect_url") or ""),
                "message": "Online payment is still active. You can retry it or switch to Cash from Checkout.",
            }

    # No payment intent was created, so this pending DB row is safe to cancel.
    order.status = "cancelled"
    order.payment_method = "Ziina Online (Cancelled)"
    await db.commit()
    return {"success": True, "order_id": order.id, "status": order.status}


@router.post("/admin/refund")
async def admin_refund_order(
    data: AdminRefundRequest,
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin-only full refund for a paid Ziina order.

    Active orders must be cancelled first. A completed order may be refunded
    directly; once Ziina confirms the refund, it is removed from sales by
    changing its status to cancelled.
    """
    if not env_bool("ZIINA_PAYMENT_ENABLED", False):
        raise HTTPException(status_code=503, detail="Online payment is currently disabled")

    order = await admin_owned_order(db, data.order_id, identity)
    clean_reason = " ".join(data.reason.split()).strip()
    order.order_notes = append_note(order.order_notes, f"Refund requested by Admin: {clean_reason}")
    payment = str(order.payment_method or "").strip().lower()
    if not payment.startswith("ziina online"):
        raise HTTPException(status_code=400, detail="This order was not paid through Ziina")

    order_status = str(order.status or "").strip().lower()
    if order_status not in {"cancelled", "completed"}:
        raise HTTPException(
            status_code=400,
            detail="Cancel the active order first, then process the card refund.",
        )

    intent_id = latest_intent_id(order)
    if not intent_id:
        raise HTTPException(status_code=400, detail="Ziina payment reference is missing for this order")

    existing = latest_refund_record(order)
    if existing and existing["status"] in {"pending", "completed"}:
        refund = await ziina_request("GET", f"/refund/{existing['id']}")
        return await apply_refund_state(db, order, refund)

    intent = await ziina_request("GET", f"/payment_intent/{intent_id}")
    if str(intent.get("status") or "").strip().lower() != "completed":
        raise HTTPException(status_code=400, detail="Ziina payment is not completed, so it cannot be refunded")
    if int(intent.get("amount") or 0) != order_amount_fils(order):
        raise HTTPException(status_code=400, detail="Ziina payment amount does not match this order")
    if str(intent.get("currency_code") or "AED").upper() != "AED":
        raise HTTPException(status_code=400, detail="Unexpected Ziina payment currency")

    refund_id = str(uuid.uuid4())
    refund = await ziina_request(
        "POST",
        "/refund",
        payload={
            "id": refund_id,
            "payment_intent_id": intent_id,
            "amount": order_amount_fils(order),
            "currency_code": "AED",
            "test": env_bool("ZIINA_TEST_MODE", True),
        },
    )
    result = await apply_refund_state(db, order, refund)
    result["reason"] = clean_reason
    return result


@router.get("/admin/refund-status/{order_id}")
async def admin_refund_status(
    order_id: int,
    identity: AdminIdentity = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    order = await admin_owned_order(db, order_id, identity)
    existing = latest_refund_record(order)
    if not existing:
        return {
            "success": True,
            "order_id": order.id,
            "status": "not_started",
            "order_status": order.status,
        }

    refund = await ziina_request("GET", f"/refund/{existing['id']}")
    return await apply_refund_state(db, order, refund)


@router.post("/webhook")
async def ziina_webhook(
    request: Request,
    x_hmac_signature: Optional[str] = Header(default=None, alias="X-Hmac-Signature"),
    db: AsyncSession = Depends(get_db),
):
    """Optional production webhook. Configure ZIINA_WEBHOOK_SECRET before live mode."""
    raw_body = await request.body()
    secret = str(os.getenv("ZIINA_WEBHOOK_SECRET", "")).strip()

    if secret:
        expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        supplied = str(x_hmac_signature or "").strip()
        if not supplied or not hmac.compare_digest(expected, supplied):
            raise HTTPException(status_code=401, detail="Invalid webhook signature")
    elif not env_bool("ZIINA_TEST_MODE", True):
        # Never accept unsigned live-payment webhooks.
        raise HTTPException(status_code=503, detail="ZIINA_WEBHOOK_SECRET is not configured")

    try:
        payload = json.loads(raw_body.decode("utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid webhook body") from exc

    if str(payload.get("event") or "") != "payment_intent.status.updated":
        return {"success": True, "ignored": True}

    event_data = payload.get("data") or {}
    if not isinstance(event_data, dict):
        return {"success": True, "ignored": True}

    intent_id = str(event_data.get("id") or event_data.get("payment_intent_id") or "").strip()
    if not intent_id:
        return {"success": True, "ignored": True}

    result = await db.execute(
        select(Orders).where(Orders.order_notes.contains(marker(intent_id))).limit(1)
    )
    order = result.scalar_one_or_none()
    if not order:
        logging.warning("Ziina webhook order not found for intent %s", intent_id)
        return {"success": True, "order_found": False}

    # Always fetch the intent directly from Ziina before releasing an order.
    intent = await ziina_request("GET", f"/payment_intent/{intent_id}")
    status = await release_paid_order(db, order, intent)
    return {"success": True, "order_found": True, "order_id": order.id, "status": status}
