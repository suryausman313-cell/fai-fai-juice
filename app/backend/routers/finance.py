# @File: backend/routers/finance.py
# @Desc: Shop, developer, rider finance reports and rider cash settlement

import json
import logging
import re
from datetime import date, datetime, time, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import get_db
from services.rider_auth import require_rider_id
from services.rider_push_service import send_rider_push
from services.branch_kitchen_auth import verify_branch_kitchen_pin
from models.delivery_assignments import Delivery_assignments
from models.orders import Orders
from models.pickup_cash_settlement_orders import Pickup_cash_settlement_orders
from models.pickup_cash_settlements import Pickup_cash_control, Pickup_cash_settlements
from models.rider_cash_settlements import Rider_cash_settlements
from models.rider_payouts import Rider_payouts
from models.riders import Riders

router = APIRouter(prefix="/api/v1/finance", tags=["finance"])
logger = logging.getLogger(__name__)

UAE_TZ = timezone(timedelta(hours=4))
PeriodName = Literal[
    "today",
    "yesterday",
    "week",
    "month",
    "year",
    "all",
    "custom",
]


class CashSubmissionCreate(BaseModel):
    amount: float = Field(gt=0, le=100000)
    note: Optional[str] = Field(default="", max_length=500)


class CashSubmissionReview(BaseModel):
    status: Literal["approved", "rejected"]
    admin_note: Optional[str] = Field(default="", max_length=500)
    reviewed_by: Optional[str] = Field(default="Admin", max_length=200)


class PickupCashSubmissionCreate(BaseModel):
    note: Optional[str] = Field(default="", max_length=500)


class PickupCashSubmissionReview(BaseModel):
    status: Literal["approved", "rejected"]
    admin_note: Optional[str] = Field(default="", max_length=500)
    reviewed_by: Optional[str] = Field(default="Admin", max_length=200)


class RiderPayoutCreate(BaseModel):
    amount: float = Field(gt=0, le=100000)
    note: Optional[str] = Field(default="", max_length=500)
    paid_by: Optional[str] = Field(default="Admin", max_length=200)
    payment_method: Literal["cash", "bank", "other"] = "cash"


def _uae_day_start(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=UAE_TZ).astimezone(
        timezone.utc
    )


def _resolve_period(
    period: PeriodName,
    date_from: Optional[str],
    date_to: Optional[str],
) -> tuple[Optional[datetime], Optional[datetime], str]:
    now_uae = datetime.now(UAE_TZ)
    today = now_uae.date()

    if period == "all":
        return None, None, "All Time"

    if period == "today":
        start_day = today
        end_day = today + timedelta(days=1)
        label = "Today"

    elif period == "yesterday":
        start_day = today - timedelta(days=1)
        end_day = today
        label = "Yesterday"

    elif period == "week":
        # Rolling 7-day report including today.
        start_day = today - timedelta(days=6)
        end_day = today + timedelta(days=1)
        label = "Last 7 Days"

    elif period == "month":
        # Rolling 30-day report including today.
        start_day = today - timedelta(days=29)
        end_day = today + timedelta(days=1)
        label = "Last 30 Days"

    elif period == "year":
        start_day = date(today.year, 1, 1)
        end_day = date(today.year + 1, 1, 1)
        label = "This Year"

    else:
        if not date_from or not date_to:
            raise HTTPException(
                status_code=400,
                detail=(
                    "Custom period requires date_from and date_to "
                    "in YYYY-MM-DD format."
                ),
            )

        try:
            start_day = date.fromisoformat(date_from)
            selected_end_day = date.fromisoformat(date_to)
        except ValueError as exc:
            raise HTTPException(
                status_code=400,
                detail="Invalid custom date. Use YYYY-MM-DD format.",
            ) from exc

        if selected_end_day < start_day:
            raise HTTPException(
                status_code=400,
                detail="date_to cannot be before date_from.",
            )

        end_day = selected_end_day + timedelta(days=1)
        label = (
            f"{start_day.isoformat()} to "
            f"{selected_end_day.isoformat()}"
        )

    return (
        _uae_day_start(start_day),
        _uae_day_start(end_day),
        label,
    )


def _apply_datetime_filter(
    query,
    column,
    start: Optional[datetime],
    end: Optional[datetime],
):
    if start is not None:
        query = query.where(column >= start)

    if end is not None:
        query = query.where(column < end)

    return query


def _in_period(
    value: Optional[datetime],
    start: Optional[datetime],
    end: Optional[datetime],
) -> bool:
    """Check one timestamp against a UTC report window."""
    if start is None and end is None:
        return True
    if value is None:
        return False
    normalized = value
    if normalized.tzinfo is None:
        normalized = normalized.replace(tzinfo=timezone.utc)
    else:
        normalized = normalized.astimezone(timezone.utc)
    if start is not None and normalized < start:
        return False
    if end is not None and normalized >= end:
        return False
    return True


def _money(value: object) -> float:
    try:
        return round(float(value or 0), 2)
    except (TypeError, ValueError):
        return 0.0


def _model_money(model: object, field_name: str) -> float:
    return _money(getattr(model, field_name, 0))


async def verify_finance_kitchen_pin(
    x_kitchen_pin: str = Header(default="", alias="X-Kitchen-Pin"),
    x_branch_id: Optional[int] = Header(default=None, alias="X-Branch-Id"),
    branch_id: Optional[int] = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> Optional[int]:
    return await verify_branch_kitchen_pin(
        db,
        x_kitchen_pin,
        x_branch_id or branch_id,
    )


def _pickup_cash_is_delivery(order: Orders) -> bool:
    explicit = str(getattr(order, "order_type", "") or "").lower().strip()
    notes = str(getattr(order, "order_notes", "") or "").lower()
    payment = str(getattr(order, "payment_method", "") or "").lower()
    return (
        explicit == "delivery"
        or "order type: delivery" in notes
        or "delivery address:" in notes
        or "cash on delivery" in payment
        or "card on delivery" in payment
    )


def _pickup_cash_is_cash(order: Orders) -> bool:
    return "cash" in str(getattr(order, "payment_method", "") or "").lower()


async def _pickup_cash_tracking_start(db: AsyncSession) -> datetime:
    control = (
        await db.execute(
            select(Pickup_cash_control).where(Pickup_cash_control.id == 1)
        )
    ).scalar_one_or_none()
    if control is not None:
        value = control.tracking_started_at
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    # First activation deliberately starts at the beginning of the current UAE
    # day so old test/history orders do not suddenly become cash due.
    start = _uae_day_start(datetime.now(UAE_TZ).date())
    control = Pickup_cash_control(id=1, tracking_started_at=start)
    db.add(control)
    try:
        await db.commit()
    except IntegrityError:
        # Another request may have created the one-row control at the same time.
        await db.rollback()
        control = (
            await db.execute(
                select(Pickup_cash_control).where(Pickup_cash_control.id == 1)
            )
        ).scalar_one()
        value = control.tracking_started_at
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    return start


async def _pickup_cash_base_orders(
    db: AsyncSession,
    branch_id: Optional[int] = None,
) -> list[Orders]:
    tracking_start = await _pickup_cash_tracking_start(db)
    completed_at = func.coalesce(
        Orders.delivered_at,
        Orders.updated_at,
        Orders.created_at,
    )
    query = (
        select(Orders)
        .where(
            func.lower(func.coalesce(Orders.status, "")).in_(["completed", "delivered"]),
            completed_at >= tracking_start,
        )
        .order_by(Orders.id)
    )
    if branch_id is not None:
        query = query.where(Orders.branch_id == int(branch_id))

    orders = (await db.execute(query)).scalars().all()
    return [
        order
        for order in orders
        if _pickup_cash_is_cash(order) and not _pickup_cash_is_delivery(order)
    ]


async def _pickup_cash_blocked_order_ids(
    db: AsyncSession,
    order_ids: list[int],
) -> set[int]:
    if not order_ids:
        return set()
    rows = await db.execute(
        select(Pickup_cash_settlement_orders.order_id)
        .join(
            Pickup_cash_settlements,
            Pickup_cash_settlements.id == Pickup_cash_settlement_orders.settlement_id,
        )
        .where(
            Pickup_cash_settlement_orders.order_id.in_(order_ids),
            Pickup_cash_settlements.status.in_(["pending", "approved"]),
        )
    )
    return {int(value) for value in rows.scalars().all()}


async def _pickup_cash_eligible_orders(
    db: AsyncSession,
    branch_id: Optional[int] = None,
) -> list[Orders]:
    orders = await _pickup_cash_base_orders(db, branch_id)
    blocked = await _pickup_cash_blocked_order_ids(db, [order.id for order in orders])
    return [order for order in orders if int(order.id) not in blocked]


async def _pickup_cash_current_balance(db: AsyncSession) -> dict:
    orders = await _pickup_cash_base_orders(db)
    completed_total = round(sum(_money(order.total_amount) for order in orders), 2)

    rows = (await db.execute(select(Pickup_cash_settlements))).scalars().all()
    approved = round(
        sum(_money(item.amount) for item in rows if str(item.status or "").lower() == "approved"),
        2,
    )
    awaiting = round(
        sum(_money(item.amount) for item in rows if str(item.status or "").lower() == "pending"),
        2,
    )
    return {
        "completed_pickup_cash": completed_total,
        "approved_cash": approved,
        "awaiting_approval": awaiting,
        "remaining_to_submit": max(round(completed_total - approved - awaiting, 2), 0.0),
    }


def _serialize_pickup_cash_order(order: Orders) -> dict:
    completed_at = (
        getattr(order, "delivered_at", None)
        or getattr(order, "updated_at", None)
        or getattr(order, "created_at", None)
    )
    return {
        "order_id": int(order.id),
        "customer_name": str(order.customer_name or "Customer"),
        "amount": _money(order.total_amount),
        "completed_at": completed_at.isoformat() if completed_at else None,
    }


def _items_subtotal(items_json: str) -> float:
    """
    Checkout stores each cart line total in item.price.
    The line price is therefore added once and is not multiplied again.
    """
    try:
        items = json.loads(items_json or "[]")
    except (TypeError, json.JSONDecodeError):
        return 0.0

    if not isinstance(items, list):
        return 0.0

    subtotal = 0.0

    for item in items:
        if not isinstance(item, dict):
            continue

        price = _money(
            item.get("price")
            or item.get("totalPrice")
            or item.get("total_price")
        )

        if price > 0:
            subtotal += price

    return round(subtotal, 2)



def _ziina_fee(order: Orders) -> float:
    """Return the actual Ziina fee stored in order notes, converted from fils to AED."""
    payment = str(getattr(order, "payment_method", "") or "").lower()
    if "ziina" not in payment:
        return 0.0

    notes = str(getattr(order, "order_notes", "") or "")
    matches = re.findall(r"Ziina Fee:\s*(\d+)", notes, flags=re.IGNORECASE)
    if not matches:
        return 0.0

    return round(max(0, int(matches[-1])) / 100.0, 2)


def _order_financials(
    order: Orders,
    assignment: Optional[Delivery_assignments] = None,
) -> dict:
    total = _money(order.total_amount)
    service_fee = _model_money(order, "service_fee")
    small_order_fee = _model_money(order, "small_order_fee")
    order_delivery_charge = _model_money(order, "delivery_charge")

    delivery_charge = order_delivery_charge

    if (
        assignment is not None
        and getattr(assignment, "delivery_charge", None) is not None
    ):
        delivery_charge = _money(assignment.delivery_charge)

    tip_amount = _model_money(order, "tip_amount")
    tip_type = str(getattr(order, "tip_type", "") or "").lower()

    rider_tip = tip_amount if tip_type == "rider" else 0.0
    shop_tip = tip_amount if tip_type == "shop" else 0.0
    developer_fees = round(service_fee + small_order_fee, 2)

    # This amount is always reliable because the customer total includes
    # food net + service fee + small-order fee + delivery + tip.
    derived_food_net = max(
        round(
            total
            - developer_fees
            - order_delivery_charge
            - tip_amount,
            2,
        ),
        0.0,
    )

    stored_food_net = _model_money(order, "food_net_total")
    food_net = stored_food_net if stored_food_net > 0 else derived_food_net

    stored_food_subtotal = _model_money(order, "food_subtotal")

    if stored_food_subtotal <= 0:
        stored_food_subtotal = _model_money(order, "subtotal_amount")

    if stored_food_subtotal <= 0:
        stored_food_subtotal = _items_subtotal(order.items_json)

    food_subtotal = max(stored_food_subtotal, food_net)

    stored_discount = _model_money(order, "discount_amount")

    if stored_discount > 0:
        discount_amount = min(stored_discount, food_subtotal)
    else:
        discount_amount = max(
            round(food_subtotal - food_net, 2),
            0.0,
        )

    assignment_status = str(
        getattr(assignment, "status", "") or ""
    ).lower()

    rider_has_delivered = (
        assignment is not None
        and assignment_status == "delivered"
    )

    rider_earning = (
        round(delivery_charge + rider_tip, 2)
        if rider_has_delivered
        else 0.0
    )

    payment_method = str(order.payment_method or "").lower()
    is_cash = "cash" in payment_method
    cash_collected = total if is_cash else 0.0
    card_collected = 0.0 if is_cash else total

    # Accounting allocation requested by the shop:
    # Ziina's actual provider fee is deducted from FOOD revenue only.
    # Delivery charge, service fee, small-order fee and tips remain untouched.
    ziina_fee = 0.0 if is_cash else _ziina_fee(order)
    shop_food_after_ziina = max(round(food_net - ziina_fee, 2), 0.0)
    online_net_received = max(round(card_collected - ziina_fee, 2), 0.0)

    # Rider cash and Rider earnings are two separate ledgers. The Rider must
    # submit the full customer cash to the shop; delivery charge + Rider tip
    # remain Rider earnings and are paid separately by Admin.
    rider_cash_payable = (
        round(cash_collected, 2)
        if is_cash and rider_has_delivered
        else 0.0
    )

    order_status = str(order.status or "").lower()
    is_delivered = (
        rider_has_delivered
        or order_status in {"delivered", "completed"}
    )

    return {
        "customer_total": total,
        "food_subtotal": round(food_subtotal, 2),
        "discount_amount": round(discount_amount, 2),
        "shop_food_sale": shop_food_after_ziina,
        "shop_food_before_ziina": round(food_net, 2),
        "ziina_fee": ziina_fee,
        "online_net_received": online_net_received,
        "service_fee": service_fee,
        "small_order_fee": small_order_fee,
        "developer_fees": developer_fees,
        "delivery_charge": order_delivery_charge,
        "rider_tip": rider_tip,
        "shop_tip": shop_tip,
        "rider_earning": rider_earning,
        "cash_collected": cash_collected,
        "card_collected": card_collected,
        "cash_payable_to_shop": rider_cash_payable,
        "is_cash": is_cash,
        "is_delivered": is_delivered,
    }


def _empty_totals() -> dict:
    return {
        "orders": 0,
        "delivered_orders": 0,
        "customer_total": 0.0,
        "food_subtotal": 0.0,
        "discount_amount": 0.0,
        "shop_food_sale": 0.0,
        "shop_food_before_ziina": 0.0,
        "ziina_fee": 0.0,
        "online_net_received": 0.0,
        "service_fee": 0.0,
        "small_order_fee": 0.0,
        "developer_fees": 0.0,
        "delivery_charges": 0.0,
        "rider_tips": 0.0,
        "shop_tips": 0.0,
        "rider_earnings": 0.0,
        "cash_collected": 0.0,
        "card_collected": 0.0,
        "cash_payable_to_shop": 0.0,
        "cash_orders": 0,
        "card_orders": 0,
    }


def _add_order_to_totals(totals: dict, values: dict) -> None:
    totals["orders"] += 1

    if values["is_delivered"]:
        totals["delivered_orders"] += 1

    totals["customer_total"] += values["customer_total"]
    totals["food_subtotal"] += values["food_subtotal"]
    totals["discount_amount"] += values["discount_amount"]
    totals["shop_food_sale"] += values["shop_food_sale"]
    totals["shop_food_before_ziina"] += values["shop_food_before_ziina"]
    totals["ziina_fee"] += values["ziina_fee"]
    totals["online_net_received"] += values["online_net_received"]
    totals["service_fee"] += values["service_fee"]
    totals["small_order_fee"] += values["small_order_fee"]
    totals["developer_fees"] += values["developer_fees"]
    totals["delivery_charges"] += values["delivery_charge"]
    totals["rider_tips"] += values["rider_tip"]
    totals["shop_tips"] += values["shop_tip"]
    totals["rider_earnings"] += values["rider_earning"]
    totals["cash_collected"] += values["cash_collected"]
    totals["card_collected"] += values["card_collected"]
    totals["cash_payable_to_shop"] += values[
        "cash_payable_to_shop"
    ]

    if values["is_cash"]:
        totals["cash_orders"] += 1
    else:
        totals["card_orders"] += 1


def _round_totals(totals: dict) -> dict:
    integer_fields = {
        "orders",
        "delivered_orders",
        "cash_orders",
        "card_orders",
    }

    return {
        key: (
            int(value)
            if key in integer_fields
            else round(float(value), 2)
        )
        for key, value in totals.items()
    }


async def _latest_assignment(
    db: AsyncSession,
    order_id: int,
) -> Optional[Delivery_assignments]:
    result = await db.execute(
        select(Delivery_assignments)
        .where(Delivery_assignments.order_id == order_id)
        .order_by(desc(Delivery_assignments.created_at))
        .limit(1)
    )

    return result.scalar_one_or_none()


async def _get_admin_order_totals(
    db: AsyncSession,
    start: Optional[datetime],
    end: Optional[datetime],
) -> dict:
    # Sales/finance are final only after Pickup Completed or Rider Delivered.
    # Rider Delivered also updates the order status to "completed".
    query = select(Orders).where(
        func.lower(func.coalesce(Orders.status, ""))
        .in_(["completed", "delivered"])
    )

    completed_at = func.coalesce(
        Orders.delivered_at,
        Orders.updated_at,
        Orders.created_at,
    )
    query = _apply_datetime_filter(
        query,
        completed_at,
        start,
        end,
    )

    orders = (await db.execute(query)).scalars().all()
    totals = _empty_totals()

    for order in orders:
        assignment = await _latest_assignment(db, order.id)

        delivered_assignment = (
            assignment
            if assignment is not None
            and str(assignment.status or "").lower() == "delivered"
            else None
        )

        _add_order_to_totals(
            totals,
            _order_financials(order, delivered_assignment),
        )

    return _round_totals(totals)


async def _get_rider_period_totals(
    db: AsyncSession,
    rider_id: int,
    start: Optional[datetime],
    end: Optional[datetime],
) -> dict:
    delivered_at = func.coalesce(
        Orders.delivered_at,
        Delivery_assignments.updated_at,
        Delivery_assignments.created_at,
    )

    query = (
        select(Delivery_assignments, Orders)
        .join(Orders, Orders.id == Delivery_assignments.order_id)
        .where(
            Delivery_assignments.rider_id == rider_id,
            Delivery_assignments.status == "delivered",
            func.lower(func.coalesce(Orders.status, ""))
            .notin_(["cancelled", "deleted", "expired"]),
        )
    )

    query = _apply_datetime_filter(
        query,
        delivered_at,
        start,
        end,
    )

    rows = (await db.execute(query)).all()
    totals = _empty_totals()

    for assignment, order in rows:
        _add_order_to_totals(
            totals,
            _order_financials(order, assignment),
        )

    return _round_totals(totals)


async def _get_settlement_totals(
    db: AsyncSession,
    rider_id: Optional[int] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> dict:
    """Settlement activity for the selected period.

    Pending cash belongs to submission time. Approved/rejected cash belongs to
    Admin review time, so an old approval never appears inside Today.
    """
    query = select(Rider_cash_settlements)

    if rider_id is not None:
        query = query.where(Rider_cash_settlements.rider_id == rider_id)

    settlements = (await db.execute(query)).scalars().all()
    approved = 0.0
    awaiting = 0.0
    rejected = 0.0
    activity_count = 0

    for item in settlements:
        status = str(item.status or "").strip().lower()
        event_time = item.submitted_at if status == "pending" else (item.reviewed_at or item.submitted_at)
        if not _in_period(event_time, start, end):
            continue
        activity_count += 1
        amount = _money(item.amount)
        if status == "approved":
            approved += amount
        elif status == "pending":
            awaiting += amount
        elif status == "rejected":
            rejected += amount

    return {
        "approved_cash": round(approved, 2),
        "awaiting_approval": round(awaiting, 2),
        "rejected_cash": round(rejected, 2),
        "submissions": activity_count,
    }


async def _get_pickup_settlement_totals(
    db: AsyncSession,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> dict:
    """Pickup-cash settlement activity for the selected approval period."""
    rows = (await db.execute(select(Pickup_cash_settlements))).scalars().all()
    approved = 0.0
    awaiting = 0.0
    rejected = 0.0
    submissions = 0
    for item in rows:
        status = str(item.status or "").strip().lower()
        event_time = item.submitted_at if status == "pending" else (item.reviewed_at or item.submitted_at)
        if not _in_period(event_time, start, end):
            continue
        submissions += 1
        amount = _money(item.amount)
        if status == "approved":
            approved += amount
        elif status == "pending":
            awaiting += amount
        elif status == "rejected":
            rejected += amount
    return {
        "approved_cash": round(approved, 2),
        "awaiting_approval": round(awaiting, 2),
        "rejected_cash": round(rejected, 2),
        "submissions": submissions,
    }


async def _get_cash_refund_totals(
    db: AsyncSession,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> dict:
    """Cash orders completed first and later cancelled are treated as cash refunds.

    delivered_at is preserved when Admin reverses a completed Pickup/Delivery sale,
    while pre-completion cancellations have no delivered_at and are never counted.
    """
    query = select(Orders).where(
        func.lower(func.coalesce(Orders.status, "")) == "cancelled",
        Orders.delivered_at.is_not(None),
        func.lower(func.coalesce(Orders.payment_method, "")).contains("cash"),
    )
    query = _apply_datetime_filter(query, Orders.updated_at, start, end)
    orders = (await db.execute(query)).scalars().all()
    return {
        "amount": round(sum(_money(order.total_amount) for order in orders), 2),
        "orders": len(orders),
    }


async def _get_payout_totals(
    db: AsyncSession,
    rider_id: Optional[int] = None,
    start: Optional[datetime] = None,
    end: Optional[datetime] = None,
) -> dict:
    query = select(Rider_payouts)

    if rider_id is not None:
        query = query.where(Rider_payouts.rider_id == rider_id)

    # Only confirmed payments count as actually paid. Pending admin-sent
    # payments remain visible to both sides until the Rider confirms receipt.
    query = query.where(
        func.lower(func.coalesce(Rider_payouts.status, "confirmed")) == "confirmed"
    )
    query = _apply_datetime_filter(
        query,
        func.coalesce(Rider_payouts.confirmed_at, Rider_payouts.paid_at),
        start,
        end,
    )

    payouts = (await db.execute(query)).scalars().all()
    total = round(sum(_money(item.amount) for item in payouts), 2)

    pending_query = select(func.coalesce(func.sum(Rider_payouts.amount), 0)).where(
        func.lower(func.coalesce(Rider_payouts.status, "confirmed")) == "pending"
    )
    if rider_id is not None:
        pending_query = pending_query.where(Rider_payouts.rider_id == rider_id)
    pending_query = _apply_datetime_filter(
        pending_query, Rider_payouts.sent_at, start, end
    )
    pending_amount = _money((await db.execute(pending_query)).scalar())

    return {
        "paid_to_rider": total,
        "payments": len(payouts),
        "pending_to_rider": pending_amount,
    }


async def _get_current_rider_balance(
    db: AsyncSession,
    rider_id: int,
) -> dict:
    all_time = await _get_rider_period_totals(
        db,
        rider_id,
        None,
        None,
    )

    settlement_totals = await _get_settlement_totals(
        db,
        rider_id,
    )
    payout_totals = await _get_payout_totals(db, rider_id)

    cash_due = _money(all_time["cash_payable_to_shop"])
    approved = _money(settlement_totals["approved_cash"])
    awaiting = _money(settlement_totals["awaiting_approval"])

    remaining_to_submit = max(
        round(cash_due - approved - awaiting, 2),
        0.0,
    )

    total_pending_cash = max(
        round(cash_due - approved, 2),
        0.0,
    )

    rider_earnings_total = _money(all_time["rider_earnings"])
    rider_paid_total = _money(payout_totals["paid_to_rider"])
    rider_pending_payment = _money(payout_totals.get("pending_to_rider"))
    rider_remaining_to_receive = max(
        round(rider_earnings_total - rider_paid_total - rider_pending_payment, 2),
        0.0,
    )

    return {
        "cash_due_to_shop": cash_due,
        "approved_cash": approved,
        "awaiting_approval": awaiting,
        "remaining_to_submit": remaining_to_submit,
        "total_pending_cash": total_pending_cash,
        "rider_earnings_total": rider_earnings_total,
        "rider_paid_total": rider_paid_total,
        "rider_pending_payment": rider_pending_payment,
        "rider_remaining_to_receive": rider_remaining_to_receive,
    }


async def _get_admin_current_balance(
    db: AsyncSession,
    riders: list[Riders],
) -> dict:
    values = {
        "cash_due_to_shop": 0.0,
        "approved_cash": 0.0,
        "awaiting_approval": 0.0,
        "remaining_to_submit": 0.0,
        "total_pending_cash": 0.0,
        "rider_earnings_total": 0.0,
        "rider_paid_total": 0.0,
        "rider_pending_payment": 0.0,
        "rider_remaining_to_receive": 0.0,
    }

    for rider in riders:
        balance = await _get_current_rider_balance(db, rider.id)

        for key in values:
            values[key] += _money(balance[key])

    return {
        key: round(value, 2)
        for key, value in values.items()
    }


@router.get("/kitchen/pickup-cash")
async def get_kitchen_pickup_cash(
    kitchen_branch_id: Optional[int] = Depends(verify_finance_kitchen_pin),
    db: AsyncSession = Depends(get_db),
):
    eligible = await _pickup_cash_eligible_orders(db, kitchen_branch_id)
    pending_query = (
        select(Pickup_cash_settlements)
        .where(Pickup_cash_settlements.status == "pending")
        .order_by(desc(Pickup_cash_settlements.submitted_at))
        .limit(20)
    )
    if kitchen_branch_id is not None:
        pending_query = pending_query.where(
            Pickup_cash_settlements.branch_id == int(kitchen_branch_id)
        )
    pending = (await db.execute(pending_query)).scalars().all()

    return {
        "orders_count": len(eligible),
        "amount": round(sum(_money(order.total_amount) for order in eligible), 2),
        "orders": [_serialize_pickup_cash_order(order) for order in eligible],
        "pending_submissions": [
            {
                "id": item.id,
                "amount": _money(item.amount),
                "orders_count": int(item.orders_count or 0),
                "status": item.status,
                "submitted_at": item.submitted_at.isoformat() if item.submitted_at else None,
            }
            for item in pending
        ],
    }


@router.post("/kitchen/pickup-cash-submissions", status_code=201)
async def submit_kitchen_pickup_cash(
    data: PickupCashSubmissionCreate,
    kitchen_branch_id: Optional[int] = Depends(verify_finance_kitchen_pin),
    db: AsyncSession = Depends(get_db),
):
    eligible = await _pickup_cash_eligible_orders(db, kitchen_branch_id)
    if not eligible:
        raise HTTPException(status_code=400, detail="No completed Pickup Cash is waiting to be submitted.")

    amount = round(sum(_money(order.total_amount) for order in eligible), 2)
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Pickup Cash total is zero.")

    settlement = Pickup_cash_settlements(
        amount=amount,
        orders_count=len(eligible),
        branch_id=kitchen_branch_id,
        status="pending",
        kitchen_note=(data.note or "").strip(),
    )
    db.add(settlement)
    await db.flush()

    for order in eligible:
        db.add(
            Pickup_cash_settlement_orders(
                settlement_id=settlement.id,
                order_id=order.id,
                order_amount=_money(order.total_amount),
            )
        )

    try:
        await db.commit()
        await db.refresh(settlement)
    except Exception as exc:
        await db.rollback()
        logger.exception("Kitchen Pickup Cash submission failed")
        raise HTTPException(status_code=500, detail="Pickup Cash could not be submitted.") from exc

    return {
        "success": True,
        "message": "Pickup Cash sent to Admin for approval.",
        "submission": {
            "id": settlement.id,
            "amount": _money(settlement.amount),
            "orders_count": int(settlement.orders_count or 0),
            "status": settlement.status,
            "submitted_at": settlement.submitted_at.isoformat() if settlement.submitted_at else None,
        },
    }


@router.get("/admin/pickup-cash-submissions")
async def get_admin_pickup_cash_submissions(
    status: Literal["all", "pending", "approved", "rejected"] = Query(default="pending"),
    limit: int = Query(default=200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    query = select(Pickup_cash_settlements).order_by(desc(Pickup_cash_settlements.submitted_at))
    if status != "all":
        query = query.where(Pickup_cash_settlements.status == status)
    settlements = (await db.execute(query.limit(limit))).scalars().all()

    settlement_ids = [int(item.id) for item in settlements]
    order_map: dict[int, list[dict]] = {item_id: [] for item_id in settlement_ids}
    if settlement_ids:
        rows = (
            await db.execute(
                select(Pickup_cash_settlement_orders, Orders)
                .join(Orders, Orders.id == Pickup_cash_settlement_orders.order_id)
                .where(Pickup_cash_settlement_orders.settlement_id.in_(settlement_ids))
                .order_by(Pickup_cash_settlement_orders.order_id)
            )
        ).all()
        for link, order in rows:
            order_map.setdefault(int(link.settlement_id), []).append(
                {
                    "order_id": int(order.id),
                    "customer_name": str(order.customer_name or "Customer"),
                    "amount": _money(link.order_amount),
                }
            )

    return {
        "items": [
            {
                "id": item.id,
                "amount": _money(item.amount),
                "orders_count": int(item.orders_count or 0),
                "status": item.status,
                "kitchen_note": item.kitchen_note or "",
                "admin_note": item.admin_note or "",
                "reviewed_by": item.reviewed_by or "",
                "submitted_at": item.submitted_at.isoformat() if item.submitted_at else None,
                "reviewed_at": item.reviewed_at.isoformat() if item.reviewed_at else None,
                "orders": order_map.get(int(item.id), []),
            }
            for item in settlements
        ]
    }


@router.put("/admin/pickup-cash-submissions/{settlement_id}")
async def review_admin_pickup_cash_submission(
    settlement_id: int,
    data: PickupCashSubmissionReview,
    db: AsyncSession = Depends(get_db),
):
    settlement = (
        await db.execute(
            select(Pickup_cash_settlements).where(Pickup_cash_settlements.id == settlement_id)
        )
    ).scalar_one_or_none()
    if not settlement:
        raise HTTPException(status_code=404, detail="Pickup Cash submission not found.")
    if str(settlement.status or "").lower() != "pending":
        raise HTTPException(
            status_code=400,
            detail=f"This Pickup Cash submission is already {settlement.status}.",
        )

    if data.status == "approved":
        linked_rows = (
            await db.execute(
                select(Pickup_cash_settlement_orders, Orders)
                .join(Orders, Orders.id == Pickup_cash_settlement_orders.order_id)
                .where(Pickup_cash_settlement_orders.settlement_id == settlement.id)
            )
        ).all()
        if not linked_rows:
            raise HTTPException(status_code=409, detail="Pickup Cash submission has no linked orders. Reject it and submit again.")

        invalid_order_ids: list[int] = []
        live_total = 0.0
        for link, order in linked_rows:
            status = str(order.status or "").lower().strip()
            valid = (
                status in {"completed", "delivered"}
                and _pickup_cash_is_cash(order)
                and not _pickup_cash_is_delivery(order)
                and abs(_money(link.order_amount) - _money(order.total_amount)) <= 0.01
            )
            if not valid:
                invalid_order_ids.append(int(order.id))
            live_total += _money(link.order_amount)

        if invalid_order_ids or abs(live_total - _money(settlement.amount)) > 0.01:
            bad = ", ".join(f"#{value}" for value in invalid_order_ids[:8])
            detail = "Pickup Cash changed after submission. Reject it and let Kitchen submit again."
            if bad:
                detail += f" Changed/cancelled order(s): {bad}."
            raise HTTPException(status_code=409, detail=detail)

    settlement.status = data.status
    settlement.admin_note = (data.admin_note or "").strip()
    settlement.reviewed_by = str(data.reviewed_by or "Admin").strip()
    settlement.reviewed_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(settlement)

    # Notify the Rider after Admin has successfully reviewed the cash.
    # Push failure must never undo a successful approval/rejection.
    try:
        status_label = "approved" if data.status == "approved" else "rejected"
        title = "Cash Approved" if data.status == "approved" else "Cash Rejected"
        body = (
            f"Your cash submission of AED {_money(settlement.amount):.2f} was {status_label}."
        )
        if settlement.admin_note:
            body += f" Note: {settlement.admin_note}"
        await send_rider_push(
            db,
            rider_id=int(settlement.rider_id),
            title=title,
            body=body,
            url="/rider",
            tag=f"rider-cash-review:{settlement.id}:{data.status}",
            kind="cash_approved" if data.status == "approved" else "cash_rejected",
        )
    except Exception:
        logger.exception(
            "Could not notify rider %s about cash submission %s review",
            settlement.rider_id,
            settlement.id,
        )

    return {
        "success": True,
        "message": f"Pickup Cash submission {data.status}.",
        "submission": {
            "id": settlement.id,
            "amount": _money(settlement.amount),
            "orders_count": int(settlement.orders_count or 0),
            "status": settlement.status,
            "admin_note": settlement.admin_note or "",
            "reviewed_by": settlement.reviewed_by or "",
            "reviewed_at": settlement.reviewed_at.isoformat() if settlement.reviewed_at else None,
        },
    }


@router.get("/rider/{rider_id}/summary")
async def get_rider_finance_summary(
    rider_id: int,
    period: PeriodName = Query(default="today"),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    require_rider_id(authorization, rider_id)
    rider = (
        await db.execute(
            select(Riders).where(Riders.id == rider_id)
        )
    ).scalar_one_or_none()

    if not rider:
        raise HTTPException(
            status_code=404,
            detail="Rider not found.",
        )

    start, end, label = _resolve_period(
        period,
        date_from,
        date_to,
    )

    period_totals = await _get_rider_period_totals(
        db,
        rider_id,
        start,
        end,
    )

    period_settlements = await _get_settlement_totals(
        db,
        rider_id,
        start,
        end,
    )
    period_payouts = await _get_payout_totals(
        db,
        rider_id,
        start,
        end,
    )

    current_balance = await _get_current_rider_balance(
        db,
        rider_id,
    )

    return {
        "rider": {
            "id": rider.id,
            "name": rider.name,
            "phone": rider.phone,
        },
        "period": {
            "key": period,
            "label": label,
            "date_from": start.isoformat() if start else None,
            "date_to": end.isoformat() if end else None,
            "display_date_from": start.astimezone(UAE_TZ).date().isoformat() if start else None,
            "display_date_to": (end - timedelta(microseconds=1)).astimezone(UAE_TZ).date().isoformat() if end else None,
        },
        "totals": period_totals,
        "settlements": period_settlements,
        "payouts": period_payouts,
        "current_balance": current_balance,
    }


@router.post(
    "/rider/{rider_id}/cash-submissions",
    status_code=201,
)
async def submit_rider_cash(
    rider_id: int,
    data: CashSubmissionCreate,
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    require_rider_id(authorization, rider_id)
    rider = (
        await db.execute(
            select(Riders).where(
                Riders.id == rider_id,
                Riders.is_active == True,
            )
        )
    ).scalar_one_or_none()

    if not rider:
        raise HTTPException(
            status_code=404,
            detail="Active rider not found.",
        )

    current_balance = await _get_current_rider_balance(
        db,
        rider_id,
    )

    remaining = _money(
        current_balance["remaining_to_submit"]
    )

    if remaining <= 0:
        raise HTTPException(
            status_code=400,
            detail="No cash is currently due to the shop.",
        )

    amount = round(float(data.amount), 2)

    if amount > remaining + 0.01:
        raise HTTPException(
            status_code=400,
            detail=(
                "Submission cannot exceed remaining cash "
                f"AED {remaining:.2f}."
            ),
        )

    settlement = Rider_cash_settlements(
        rider_id=rider_id,
        amount=amount,
        status="pending",
        rider_note=(data.note or "").strip(),
    )

    db.add(settlement)
    await db.commit()
    await db.refresh(settlement)

    return {
        "success": True,
        "message": (
            "Cash submission sent to admin for approval."
        ),
        "submission": {
            "id": settlement.id,
            "rider_id": settlement.rider_id,
            "amount": _money(settlement.amount),
            "status": settlement.status,
            "submitted_at": (
                settlement.submitted_at.isoformat()
                if settlement.submitted_at
                else None
            ),
        },
    }


@router.get("/rider/{rider_id}/cash-submissions")
async def get_rider_cash_submissions(
    rider_id: int,
    limit: int = Query(default=100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
):
    require_rider_id(authorization, rider_id)
    result = await db.execute(
        select(Rider_cash_settlements)
        .where(
            Rider_cash_settlements.rider_id == rider_id
        )
        .order_by(
            desc(Rider_cash_settlements.submitted_at)
        )
        .limit(limit)
    )

    items = result.scalars().all()

    return {
        "items": [
            {
                "id": item.id,
                "rider_id": item.rider_id,
                "amount": _money(item.amount),
                "status": item.status,
                "rider_note": item.rider_note or "",
                "admin_note": item.admin_note or "",
                "reviewed_by": item.reviewed_by or "",
                "submitted_at": (
                    item.submitted_at.isoformat()
                    if item.submitted_at
                    else None
                ),
                "reviewed_at": (
                    item.reviewed_at.isoformat()
                    if item.reviewed_at
                    else None
                ),
            }
            for item in items
        ]
    }


@router.get("/admin/summary")
async def get_admin_finance_summary(
    period: PeriodName = Query(default="today"),
    date_from: Optional[str] = Query(default=None),
    date_to: Optional[str] = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    start, end, label = _resolve_period(
        period,
        date_from,
        date_to,
    )

    riders = (
        await db.execute(
            select(Riders).order_by(Riders.name)
        )
    ).scalars().all()

    overall = await _get_admin_order_totals(
        db,
        start,
        end,
    )

    rider_items = []

    for rider in riders:
        totals = await _get_rider_period_totals(
            db,
            rider.id,
            start,
            end,
        )

        period_settlements = await _get_settlement_totals(
            db,
            rider.id,
            start,
            end,
        )
        period_payouts = await _get_payout_totals(
            db,
            rider.id,
            start,
            end,
        )

        current_balance = await _get_current_rider_balance(
            db,
            rider.id,
        )

        rider_items.append(
            {
                "rider_id": rider.id,
                "rider_name": rider.name,
                "rider_phone": rider.phone,
                "is_active": bool(rider.is_active),
                "totals": totals,
                "settlements": period_settlements,
                "payouts": period_payouts,
                "current_balance": current_balance,
            }
        )

    all_settlements = await _get_settlement_totals(
        db,
        None,
        start,
        end,
    )
    pickup_period_settlements = await _get_pickup_settlement_totals(db, start, end)
    cash_refunds = await _get_cash_refund_totals(db, start, end)
    gross_approved_cash = round(
        _money(all_settlements.get("approved_cash"))
        + _money(pickup_period_settlements.get("approved_cash")),
        2,
    )
    net_admin_cash_received = max(
        round(gross_approved_cash - _money(cash_refunds.get("amount")), 2),
        0.0,
    )
    cash_waiting_admin = round(
        _money(all_settlements.get("awaiting_approval"))
        + _money(pickup_period_settlements.get("awaiting_approval")),
        2,
    )
    all_payouts = await _get_payout_totals(
        db,
        None,
        start,
        end,
    )

    current_balance = await _get_admin_current_balance(
        db,
        list(riders),
    )
    pickup_cash = await _pickup_cash_current_balance(db)

    return {
        "period": {
            "key": period,
            "label": label,
            "date_from": start.isoformat() if start else None,
            "date_to": end.isoformat() if end else None,
            "display_date_from": start.astimezone(UAE_TZ).date().isoformat() if start else None,
            "display_date_to": (end - timedelta(microseconds=1)).astimezone(UAE_TZ).date().isoformat() if end else None,
        },
        "totals": overall,
        "settlements": all_settlements,
        "pickup_settlements": pickup_period_settlements,
        "cash_control": {
            "rider_approved_cash": _money(all_settlements.get("approved_cash")),
            "pickup_approved_cash": _money(pickup_period_settlements.get("approved_cash")),
            "gross_approved_cash": gross_approved_cash,
            "cash_refunds": _money(cash_refunds.get("amount")),
            "cash_refund_orders": int(cash_refunds.get("orders") or 0),
            "net_received": net_admin_cash_received,
            "awaiting_approval": cash_waiting_admin,
        },
        "payouts": all_payouts,
        "current_balance": current_balance,
        "pickup_cash": pickup_cash,
        "riders": rider_items,
        "rules": {
            "discount_applies_to": "menu_items_only",
            "shop_sale": (
                "food_subtotal_minus_discount_minus_ziina_fee"
            ),
            "ziina_fee_allocation": "food_items_only",
            "developer_fees": (
                "service_fee_plus_small_order_fee"
            ),
            "rider_earning": (
                "delivery_charge_plus_rider_tip"
            ),
            "rider_cash_to_shop": "full_cash_customer_total",
            "rider_payout": "admin_records_separately",
        },
    }


@router.get("/admin/cash-submissions")
async def get_admin_cash_submissions(
    status: Literal[
        "all",
        "pending",
        "approved",
        "rejected",
    ] = Query(default="pending"),
    rider_id: Optional[int] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(Rider_cash_settlements, Riders)
        .join(
            Riders,
            Riders.id == Rider_cash_settlements.rider_id,
        )
        .order_by(
            desc(Rider_cash_settlements.submitted_at)
        )
    )

    if status != "all":
        query = query.where(
            Rider_cash_settlements.status == status
        )

    if rider_id is not None:
        query = query.where(
            Rider_cash_settlements.rider_id == rider_id
        )

    rows = (
        await db.execute(query.limit(limit))
    ).all()

    return {
        "items": [
            {
                "id": settlement.id,
                "rider_id": rider.id,
                "rider_name": rider.name,
                "rider_phone": rider.phone,
                "amount": _money(settlement.amount),
                "status": settlement.status,
                "rider_note": settlement.rider_note or "",
                "admin_note": settlement.admin_note or "",
                "reviewed_by": settlement.reviewed_by or "",
                "submitted_at": (
                    settlement.submitted_at.isoformat()
                    if settlement.submitted_at
                    else None
                ),
                "reviewed_at": (
                    settlement.reviewed_at.isoformat()
                    if settlement.reviewed_at
                    else None
                ),
            }
            for settlement, rider in rows
        ]
    }


@router.put("/admin/cash-submissions/{settlement_id}")
async def review_cash_submission(
    settlement_id: int,
    data: CashSubmissionReview,
    db: AsyncSession = Depends(get_db),
):
    settlement = (
        await db.execute(
            select(Rider_cash_settlements).where(
                Rider_cash_settlements.id == settlement_id
            )
        )
    ).scalar_one_or_none()

    if not settlement:
        raise HTTPException(
            status_code=404,
            detail="Cash submission not found.",
        )

    if settlement.status != "pending":
        raise HTTPException(
            status_code=400,
            detail=(
                "This submission is already "
                f"{settlement.status}."
            ),
        )

    if data.status == "approved":
        all_time = await _get_rider_period_totals(db, int(settlement.rider_id), None, None)
        approved_query = select(Rider_cash_settlements).where(
            Rider_cash_settlements.rider_id == int(settlement.rider_id),
            Rider_cash_settlements.status == "approved",
        )
        approved_rows = (await db.execute(approved_query)).scalars().all()
        already_approved = round(sum(_money(item.amount) for item in approved_rows), 2)
        still_due = max(round(_money(all_time.get("cash_payable_to_shop")) - already_approved, 2), 0.0)
        if _money(settlement.amount) > still_due + 0.01:
            raise HTTPException(
                status_code=409,
                detail=(
                    "Rider cash due changed after submission (an order may have been cancelled/refunded). "
                    "Reject this submission and ask the Rider to submit the current amount again."
                ),
            )

    reviewed_by = data.reviewed_by or "Admin"

    settlement.status = data.status
    settlement.admin_note = (data.admin_note or "").strip()
    settlement.reviewed_by = str(reviewed_by).strip()
    settlement.reviewed_at = datetime.now(timezone.utc)

    await db.commit()
    await db.refresh(settlement)

    return {
        "success": True,
        "message": (
            f"Cash submission {data.status}."
        ),
        "submission": {
            "id": settlement.id,
            "rider_id": settlement.rider_id,
            "amount": _money(settlement.amount),
            "status": settlement.status,
            "admin_note": settlement.admin_note or "",
            "reviewed_by": settlement.reviewed_by or "",
            "reviewed_at": (
                settlement.reviewed_at.isoformat()
                if settlement.reviewed_at
                else None
            ),
        },
    }

@router.post("/admin/riders/{rider_id}/payouts", status_code=201)
async def record_rider_payout(
    rider_id: int,
    data: RiderPayoutCreate,
    db: AsyncSession = Depends(get_db),
):
    rider = (
        await db.execute(select(Riders).where(Riders.id == rider_id))
    ).scalar_one_or_none()
    if not rider:
        raise HTTPException(status_code=404, detail="Rider not found.")

    balance = await _get_current_rider_balance(db, rider_id)
    remaining = _money(balance["rider_remaining_to_receive"])
    if remaining <= 0:
        raise HTTPException(status_code=400, detail="No Rider earning is currently due.")

    amount = round(float(data.amount), 2)
    if amount > remaining + 0.01:
        raise HTTPException(
            status_code=400,
            detail=f"Payment cannot exceed Rider balance AED {remaining:.2f}.",
        )

    now = datetime.now(timezone.utc)
    payout = Rider_payouts(
        rider_id=rider_id,
        amount=amount,
        note=(data.note or "").strip(),
        paid_by=(data.paid_by or "Admin").strip(),
        payment_method=data.payment_method,
        status="pending",
        sent_at=now,
        paid_at=now,
        confirmed_at=None,
    )
    db.add(payout)
    await db.commit()
    await db.refresh(payout)

    return {
        "success": True,
        "message": "Payment sent to Rider for confirmation.",
        "payout": {
            "id": payout.id,
            "rider_id": payout.rider_id,
            "amount": _money(payout.amount),
            "note": payout.note or "",
            "paid_by": payout.paid_by or "",
            "payment_method": payout.payment_method or "",
            "status": payout.status or "confirmed",
            "sent_at": payout.sent_at.isoformat() if payout.sent_at else None,
            "confirmed_at": payout.confirmed_at.isoformat() if payout.confirmed_at else None,
            "paid_at": payout.paid_at.isoformat() if payout.paid_at else None,
        },
    }


@router.get("/admin/rider-payouts")
async def get_admin_rider_payouts(
    rider_id: Optional[int] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    query = (
        select(Rider_payouts, Riders)
        .join(Riders, Riders.id == Rider_payouts.rider_id)
        .order_by(desc(Rider_payouts.paid_at))
    )
    if rider_id is not None:
        query = query.where(Rider_payouts.rider_id == rider_id)

    rows = (await db.execute(query.limit(limit))).all()
    return {
        "items": [
            {
                "id": payout.id,
                "rider_id": rider.id,
                "rider_name": rider.name,
                "amount": _money(payout.amount),
                "note": payout.note or "",
                "paid_by": payout.paid_by or "",
                "payment_method": payout.payment_method or "",
                "status": payout.status or "confirmed",
                "sent_at": payout.sent_at.isoformat() if payout.sent_at else None,
                "confirmed_at": payout.confirmed_at.isoformat() if payout.confirmed_at else None,
                "paid_at": payout.paid_at.isoformat() if payout.paid_at else None,
            }
            for payout, rider in rows
        ]
    }


@router.post("/rider/{rider_id}/payouts/{payout_id}/confirm")
async def confirm_rider_payout(
    rider_id: int,
    payout_id: int,
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    require_rider_id(authorization, rider_id)
    payout = (
        await db.execute(
            select(Rider_payouts).where(
                Rider_payouts.id == payout_id,
                Rider_payouts.rider_id == rider_id,
            )
        )
    ).scalar_one_or_none()
    if not payout:
        raise HTTPException(status_code=404, detail="Rider payment not found.")
    status_value = str(payout.status or "confirmed").lower()
    if status_value == "confirmed":
        return {"success": True, "message": "Payment already confirmed.", "status": "confirmed"}
    if status_value != "pending":
        raise HTTPException(status_code=400, detail="This payment cannot be confirmed.")

    payout.status = "confirmed"
    payout.confirmed_at = datetime.now(timezone.utc)
    payout.paid_at = payout.confirmed_at
    await db.commit()
    await db.refresh(payout)

    return {
        "success": True,
        "message": "Rider payment confirmed.",
        "status": "confirmed",
        "amount": _money(payout.amount),
        "confirmed_at": payout.confirmed_at.isoformat(),
    }


@router.get("/rider/{rider_id}/payouts")
async def get_rider_payouts(
    rider_id: int,
    limit: int = Query(default=100, ge=1, le=500),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    require_rider_id(authorization, rider_id)
    items = (
        await db.execute(
            select(Rider_payouts)
            .where(Rider_payouts.rider_id == rider_id)
            .order_by(desc(Rider_payouts.paid_at))
            .limit(limit)
        )
    ).scalars().all()
    return {
        "items": [
            {
                "id": item.id,
                "rider_id": item.rider_id,
                "amount": _money(item.amount),
                "note": item.note or "",
                "paid_by": item.paid_by or "",
                "payment_method": item.payment_method or "",
                "status": item.status or "confirmed",
                "sent_at": item.sent_at.isoformat() if item.sent_at else None,
                "confirmed_at": item.confirmed_at.isoformat() if item.confirmed_at else None,
                "paid_at": item.paid_at.isoformat() if item.paid_at else None,
            }
            for item in items
        ]
    }

