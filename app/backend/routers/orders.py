# @File: backend/routers/orders.py
# @Desc: Customer-facing order placement API
import json
import logging
import math
import os
from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func, or_, update
from typing import Optional

from core.database import get_db
from models.orders import Orders
from models.menu_items import Menu_items
from models.offers import Offers
from models.customer_rewards import Customer_rewards
from services.rider_assignment import auto_assign_order, cancel_order_assignments
from services.order_notes import public_order_notes
from routers.customer_auth import (
    decode_customer_token,
    get_bearer_token,
    normalize_phone,
)

router = APIRouter(prefix="/api/v1/orders", tags=["orders"])


def get_guest_user_id(session_id: str) -> str:
    """Build a stable anonymous order owner ID without requiring customer login."""
    value = (session_id or "").strip()
    if len(value) < 8 or len(value) > 120:
        raise HTTPException(status_code=400, detail="Invalid customer session. Please refresh the app and try again.")
    if not all(ch.isalnum() or ch in "_-" for ch in value):
        raise HTTPException(status_code=400, detail="Invalid customer session. Please refresh the app and try again.")
    return f"guest:{value}"


class PlaceOrderRequest(BaseModel):
    # Browser money fields are accepted only for backwards compatibility/UI
    # freshness checks. The backend recalculates all chargeable amounts.
    session_id: str = Field(min_length=8, max_length=120)
    customer_name: str = Field(min_length=1, max_length=120)
    customer_phone: str = Field(min_length=5, max_length=40)
    order_notes: Optional[str] = Field(default="", max_length=1000)
    payment_method: str = Field(min_length=2, max_length=40)
    total_amount: float = Field(ge=0, le=100000)
    subtotal_amount: Optional[float] = Field(default=0, ge=0, le=100000)
    promo_code: Optional[str] = Field(default="", max_length=80)
    discount_type: Optional[str] = Field(default="", max_length=40)
    discount_percent: Optional[float] = Field(default=0, ge=0, le=100)
    discount_amount: Optional[float] = Field(default=0, ge=0, le=100000)
    service_fee: Optional[float] = Field(default=0, ge=0, le=100000)
    small_order_fee: Optional[float] = Field(default=0, ge=0, le=100000)
    delivery_charge: Optional[float] = Field(default=0, ge=0, le=100000)
    tax_amount: Optional[float] = Field(default=0, ge=0, le=100000)
    tip_amount: Optional[float] = Field(default=0, ge=0, le=500)
    tip_type: Optional[str] = Field(default="", max_length=20)  # 'rider' or 'shop'
    items_json: str = Field(min_length=2, max_length=100000)
    # Optional reward selected by the customer. Old app builds omit it safely.
    reward_id: Optional[int] = Field(default=None, ge=1)


class DeliveryLocationData(BaseModel):
    customer_lat: Optional[float] = Field(default=None, ge=-90, le=90)
    customer_lng: Optional[float] = Field(default=None, ge=-180, le=180)
    order_type: Optional[str] = Field(default="pickup", max_length=20)  # 'pickup' or 'delivery'


class PlaceOrderFullRequest(PlaceOrderRequest):
    customer_lat: Optional[float] = Field(default=None, ge=-90, le=90)
    customer_lng: Optional[float] = Field(default=None, ge=-180, le=180)
    customer_address: Optional[str] = Field(default="", max_length=500)
    order_type: Optional[str] = Field(default="pickup", max_length=20)
    branch_id: Optional[int] = Field(default=None, ge=1)
    # When the customer leaves a Ziina hosted checkout and explicitly chooses
    # Cash, this identifies the pending online order being replaced.
    replace_pending_payment_order_id: Optional[int] = Field(default=None, ge=1)


@router.post("/place")
async def place_order(
    data: PlaceOrderFullRequest,
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    """Place an order using server-side pricing and fulfilment validation."""
    try:
        from datetime import datetime, timedelta, timezone
        from zoneinfo import ZoneInfo

        from models.restaurant_settings import Restaurant_settings
        from services.order_pricing import money, validate_and_price_order_items

        dubai_tz = ZoneInfo("Asia/Dubai")

        def parse_time_minutes(value: object) -> int | None:
            raw = str(value or "").strip()
            if not raw:
                return None
            try:
                hour_text, minute_text = raw.split(":", 1)
                hour = int(hour_text)
                minute = int(minute_text[:2])
            except (TypeError, ValueError):
                return None
            if not (0 <= hour <= 23 and 0 <= minute <= 59):
                return None
            return hour * 60 + minute

        def within_schedule(now_minutes: int, start_value: object, end_value: object) -> bool:
            start = parse_time_minutes(start_value)
            end = parse_time_minutes(end_value)
            if start is None or end is None:
                return True
            if start == end:
                return True
            if end < start:
                return now_minutes >= start or now_minutes < end
            return start <= now_minutes < end

        customer_payload = decode_customer_token(get_bearer_token(authorization))
        account_phone = normalize_phone(str(customer_payload.get("phone") or ""))
        submitted_phone = normalize_phone(data.customer_phone)
        if account_phone != submitted_phone:
            raise HTTPException(
                status_code=403,
                detail="Order mobile number must match the logged-in customer account",
            )

        guest_user_id = f"customer:{customer_payload.get('sub', '')}"
        data.customer_phone = account_phone
        data.customer_name = str(
            customer_payload.get("customer_name") or data.customer_name
        ).strip()
        if not data.customer_name:
            raise HTTPException(status_code=400, detail="Customer name is required")

        normalized_order_type = str(data.order_type or "pickup").lower().strip()
        if normalized_order_type not in {"pickup", "delivery"}:
            raise HTTPException(status_code=400, detail="Invalid order type")

        settings_result = await db.execute(
            select(Restaurant_settings).order_by(desc(Restaurant_settings.id)).limit(1)
        )
        settings = settings_result.scalar_one_or_none()

        # ===== BRANCH ROUTING (backwards compatible) =====
        # Old customer builds do not send branch_id. They continue using the
        # default branch, so rolling out this backend cannot break the live app.
        from models.branches import Branches

        branch = None
        if data.branch_id is not None:
            branch = (await db.execute(
                select(Branches).where(
                    Branches.id == int(data.branch_id),
                    Branches.is_active.is_(True),
                ).limit(1)
            )).scalar_one_or_none()
            if branch is None:
                raise HTTPException(status_code=400, detail="Selected branch is not available. Please choose another branch.")
        else:
            branch = (await db.execute(
                select(Branches)
                .where(Branches.is_active.is_(True))
                .order_by(desc(Branches.is_default), Branches.id)
                .limit(1)
            )).scalar_one_or_none()

        # ===== SHOP OPEN/CLOSED + ORDER-TYPE RULES =====
        now_dubai = datetime.now(dubai_tz)
        current_minutes = now_dubai.hour * 60 + now_dubai.minute
        status_lower = str(getattr(settings, "restaurant_status", "open") or "open").lower().strip()
        auto_enabled = bool(settings and getattr(settings, "auto_schedule_enabled", False))

        # Auto Open/Close is authoritative when enabled. A stale manual `open`
        # can no longer accept orders after closing time, and a stale `closed`
        # no longer prevents the configured automatic opening.
        if auto_enabled:
            if not within_schedule(current_minutes, settings.auto_open_time, settings.auto_close_time):
                raise HTTPException(
                    status_code=403,
                    detail="Sorry, the restaurant is currently closed. Please try again during opening hours.",
                )
        elif status_lower == "closed":
            raise HTTPException(
                status_code=403,
                detail="Sorry, the restaurant is currently closed. Please try again during opening hours.",
            )

        if normalized_order_type == "delivery":
            if not settings or settings.delivery_enabled is not True:
                raise HTTPException(status_code=403, detail="Delivery is currently unavailable. Please choose Pickup.")
            if (
                bool(settings.delivery_schedule_enabled)
                and not within_schedule(current_minutes, settings.delivery_start_time, settings.delivery_end_time)
            ):
                raise HTTPException(
                    status_code=403,
                    detail=f"Delivery is available from {settings.delivery_start_time or '16:00'} to {settings.delivery_end_time or '01:00'}. Please choose Pickup for now.",
                )
            if data.customer_lat is None or data.customer_lng is None:
                raise HTTPException(
                    status_code=400,
                    detail="Delivery location is required. Please select your location on the map.",
                )
            if not (-90 <= float(data.customer_lat) <= 90 and -180 <= float(data.customer_lng) <= 180):
                raise HTTPException(status_code=400, detail="Invalid delivery location")
            # A map/GPS pin is the authoritative delivery location.
            # The free-text address/notes field is optional because reverse-geocoding
            # may be unavailable or the customer may only share a map pin.

        # ===== PAYMENT METHOD RULES =====
        payment_text = str(data.payment_method or "").lower().strip()

        # Ziina must be checked before the ordinary cash/card rules.
        # The frontend sends "Ziina Online" for hosted online payments.
        if payment_text.startswith("ziina online"):
            payment_kind = "ziina"
        elif "cash" in payment_text:
            payment_kind = "cash"
        elif "card" in payment_text:
            payment_kind = "card"
        else:
            raise HTTPException(status_code=400, detail="Invalid payment method")

        if payment_kind == "ziina":
            ziina_enabled = str(os.getenv("ZIINA_PAYMENT_ENABLED", "false")).strip().lower() in {
                "1", "true", "yes", "on"
            }
            ziina_test_mode = str(os.getenv("ZIINA_TEST_MODE", "true")).strip().lower() in {
                "1", "true", "yes", "on"
            }
            if not ziina_enabled and not ziina_test_mode:
                raise HTTPException(
                    status_code=400,
                    detail="Online payment is currently unavailable",
                )
        elif settings:
            if normalized_order_type == "pickup":
                allowed = (
                    settings.cash_enabled_pickup is not False
                    if payment_kind == "cash"
                    else settings.card_enabled_pickup is not False
                )
            else:
                allowed = (
                    settings.cash_enabled_delivery is not False
                    if payment_kind == "cash"
                    else settings.card_enabled_delivery is not False
                )
            if not allowed:
                raise HTTPException(
                    status_code=400,
                    detail="Selected payment method is currently unavailable",
                )

        # ===== SERVER-SIDE CART VALIDATION / PRICING =====
        subtotal_amount, canonical_items = await validate_and_price_order_items(db, data.items_json)
        canonical_items_json = json.dumps(canonical_items, ensure_ascii=False, separators=(",", ":"))
        # Internal marker lets duplicate protection distinguish two different
        # customer devices logged into the same account. It is stripped from
        # all customer/admin/kitchen-visible notes by public_order_notes().
        client_session_marker = f"Client Session: {data.session_id.strip()}"

        # ===== DELIVERY SERVER SOURCE OF TRUTH =====
        delivery_charge = 0.0
        delivery_distance_km = None
        delivery_zone_name = ""
        if normalized_order_type == "delivery":
            try:
                from routers.delivery_zones import CalculateChargeRequest, evaluate_delivery_location

                restaurant_lat = (
                    float(branch.latitude)
                    if branch is not None
                    else (float(settings.restaurant_lat) if settings and settings.restaurant_lat else 25.2747)
                )
                restaurant_lng = (
                    float(branch.longitude)
                    if branch is not None
                    else (float(settings.restaurant_lng) if settings and settings.restaurant_lng else 56.3450)
                )
                delivery_result = await evaluate_delivery_location(
                    CalculateChargeRequest(
                        customer_lat=float(data.customer_lat),
                        customer_lng=float(data.customer_lng),
                        restaurant_lat=restaurant_lat,
                        restaurant_lng=restaurant_lng,
                    ),
                    db,
                )
            except HTTPException:
                raise
            except Exception:
                logging.exception("Delivery validation failed")
                raise HTTPException(status_code=503, detail="Could not verify delivery location. Please try again.")

            if not bool(delivery_result.get("available")):
                raise HTTPException(
                    status_code=400,
                    detail=str(delivery_result.get("message") or "Delivery is not available at this location."),
                )
            delivery_charge = money(delivery_result.get("charge"))
            if delivery_charge <= 0:
                raise HTTPException(status_code=400, detail="Delivery charge is not configured for this location")
            try:
                delivery_distance_km = float(delivery_result.get("distance_km"))
            except (TypeError, ValueError):
                delivery_distance_km = None
            delivery_zone_name = str(delivery_result.get("zone_name") or "")[:100]

        # ===== PROMO / REWARD VALIDATION =====
        # A customer can use ONE reward OR ONE promo code, never both.
        promo_code = str(data.promo_code or "").strip().upper()
        discount_type = ""
        discount_percent = 0.0
        discount_amount = 0.0
        selected_reward = None

        if data.reward_id is not None:
            if promo_code:
                raise HTTPException(status_code=400, detail="Promo code and reward cannot be used together")

            from routers.rewards import get_reward_for_checkout

            selected_reward = await get_reward_for_checkout(
                db,
                customer_id=int(customer_payload.get("sub")),
                reward_id=int(data.reward_id),
            )

            # Repair/defence for rewards created by an older buggy build:
            # if this reward ID is already recorded on a real previous order,
            # mark it redeemed and refuse to apply it again. This fixes existing
            # customers immediately, not only rewards used after this deployment.
            prior_reward_order_id = await db.scalar(
                select(Orders.id)
                .where(
                    Orders.user_id == guest_user_id,
                    Orders.status.notin_(["cancelled", "expired", "payment_pending"]),
                    Orders.discount_type.like("reward_%"),
                    Orders.order_notes.like(f"%Reward:%(#{int(selected_reward.id)})%"),
                )
                .order_by(Orders.id.desc())
                .limit(1)
            )
            if prior_reward_order_id:
                await db.execute(
                    update(Customer_rewards)
                    .where(
                        Customer_rewards.id == int(selected_reward.id),
                        Customer_rewards.customer_id == int(customer_payload.get("sub")),
                    )
                    .values(
                        status="redeemed",
                        redeemed_order_id=int(prior_reward_order_id),
                        redeemed_at=datetime.now(timezone.utc),
                    )
                )
                await db.commit()
                raise HTTPException(
                    status_code=409,
                    detail="This reward was already used. Please choose another reward.",
                )

            minimum = money(selected_reward.minimum_order)
            if subtotal_amount + 0.001 < minimum:
                raise HTTPException(
                    status_code=400,
                    detail=f"Minimum order for this reward is AED {minimum:.2f}",
                )

            reward_type = str(selected_reward.reward_type or "").lower().strip()
            reward_value = money(selected_reward.reward_value)
            maximum = money(selected_reward.max_discount)

            if reward_type == "fixed":
                discount_type = "reward_fixed"
                discount_amount = min(subtotal_amount, reward_value)
            elif reward_type == "percent":
                discount_type = "reward_percentage"
                discount_percent = max(0.0, min(100.0, reward_value))
                discount_amount = money(subtotal_amount * discount_percent / 100)
            elif reward_type == "free_ice_cream":
                eligible = [
                    item for item in canonical_items
                    if not bool(item.get("is_deal"))
                    and "ice cream" in str(item.get("name") or "").lower()
                    and money(item.get("unit_price")) <= 5.01
                ]
                if not eligible:
                    raise HTTPException(
                        status_code=400,
                        detail="Add one Small Ice Cream (AED 5 or less) to use this reward",
                    )
                discount_type = "reward_free_ice_cream"
                discount_amount = min(5.0, min(money(item.get("unit_price")) for item in eligible))
            elif reward_type == "golden_free_item":
                blocked_words = ("acai", "smoothie", "bottle", "box")
                eligible = [
                    item for item in canonical_items
                    if not bool(item.get("is_deal"))
                    and money(item.get("unit_price")) <= 15.01
                    and not any(word in str(item.get("name") or "").lower() for word in blocked_words)
                ]
                if not eligible:
                    raise HTTPException(
                        status_code=400,
                        detail="Add an eligible item priced AED 15 or less to use this Golden reward",
                    )
                discount_type = "reward_golden_free_item"
                discount_amount = min(15.0, max(money(item.get("unit_price")) for item in eligible))
            else:
                raise HTTPException(status_code=400, detail="Unsupported reward type")

            if maximum > 0:
                discount_amount = min(discount_amount, maximum)
            discount_amount = money(max(0.0, min(subtotal_amount, discount_amount)))

        elif promo_code:
            offer_result = await db.execute(
                select(Offers).where(
                    Offers.is_active.is_(True),
                    func.upper(func.trim(Offers.promo_code)) == promo_code,
                ).limit(1)
            )
            offer = offer_result.scalar_one_or_none()
            if not offer:
                raise HTTPException(status_code=400, detail="Invalid or inactive promo code")

            def parse_offer_time(value: Optional[str], end_of_day: bool = False):
                if not value:
                    return None
                raw = str(value).strip().replace("Z", "+00:00")
                try:
                    parsed = datetime.fromisoformat(raw)
                except ValueError:
                    try:
                        parsed = datetime.strptime(raw, "%Y-%m-%d")
                        if end_of_day:
                            parsed = parsed.replace(hour=23, minute=59, second=59)
                    except ValueError:
                        return None
                if parsed.tzinfo is None:
                    # Admin offer dates are entered in UAE local time. Treat
                    # timezone-less values as Asia/Dubai so backend validation
                    # matches the customer checkout and does not shift by 4h.
                    parsed = parsed.replace(tzinfo=dubai_tz)
                return parsed.astimezone(timezone.utc)

            now_utc = datetime.now(timezone.utc)
            start_at = parse_offer_time(offer.start_date)
            end_at = parse_offer_time(offer.end_date, end_of_day=True)
            if start_at and now_utc < start_at:
                raise HTTPException(status_code=400, detail="Promo code is not active yet")
            if end_at and now_utc > end_at:
                raise HTTPException(status_code=400, detail="Promo code has expired")

            minimum = money(offer.minimum_order_amount)
            if subtotal_amount + 0.001 < minimum:
                raise HTTPException(
                    status_code=400,
                    detail=f"Minimum order for this promo is AED {minimum:.2f}",
                )

            active_order_filter = Orders.status.notin_(["cancelled", "expired", "payment_pending"])
            if bool(offer.first_order_only):
                previous_count = await db.scalar(
                    select(func.count(Orders.id)).where(
                        Orders.user_id == guest_user_id,
                        active_order_filter,
                    )
                )
                if int(previous_count or 0) > 0:
                    raise HTTPException(status_code=400, detail="This promo is for first orders only")

            per_customer_limit = int(offer.usage_limit_per_customer or 0)
            if per_customer_limit > 0:
                customer_usage = await db.scalar(
                    select(func.count(Orders.id)).where(
                        Orders.user_id == guest_user_id,
                        func.upper(func.trim(Orders.promo_code)) == promo_code,
                        active_order_filter,
                    )
                )
                if int(customer_usage or 0) >= per_customer_limit:
                    raise HTTPException(status_code=400, detail="Promo usage limit reached")

            total_limit = int(offer.total_usage_limit or 0)
            if total_limit > 0:
                total_usage = await db.scalar(
                    select(func.count(Orders.id)).where(
                        func.upper(func.trim(Orders.promo_code)) == promo_code,
                        active_order_filter,
                    )
                )
                if int(total_usage or 0) >= total_limit:
                    raise HTTPException(status_code=400, detail="Promo total usage limit reached")

            discount_type = str(offer.discount_type or "percentage").lower().strip()
            if discount_type == "fixed":
                discount_amount = min(subtotal_amount, money(offer.fixed_discount_amount))
            else:
                discount_type = "percentage"
                discount_percent = max(0.0, min(100.0, float(offer.discount_percent or 0)))
                discount_amount = money(subtotal_amount * discount_percent / 100)

            maximum = money(offer.maximum_discount_amount)
            if maximum > 0:
                discount_amount = min(discount_amount, maximum)
            discount_amount = money(max(0.0, discount_amount))

        # ===== FEES FROM DATABASE SETTINGS =====
        service_fee = 0.0
        if settings and bool(settings.service_fee_enabled):
            applies_to = str(settings.service_fee_applies_to or "both").lower().strip()
            if applies_to in {"both", normalized_order_type}:
                fee_amount = max(0.0, float(settings.service_fee_amount or 0))
                if str(settings.service_fee_type or "fixed").lower().strip() == "percentage":
                    service_fee = money(subtotal_amount * fee_amount / 100)
                else:
                    service_fee = money(fee_amount)

        small_order_fee = 0.0
        if settings and bool(settings.small_order_fee_enabled):
            threshold = max(0.0, float(settings.small_order_fee_threshold or 0))
            if subtotal_amount < threshold:
                small_order_fee = money(max(0.0, float(settings.small_order_fee_amount or 0)))

        tip_amount = money(data.tip_amount)
        if tip_amount < 0 or tip_amount > 500:
            raise HTTPException(status_code=400, detail="Tip amount must be between AED 0 and AED 500")
        normalized_tip_type = str(data.tip_type or "").lower().strip()
        if tip_amount > 0:
            expected_tip_type = "rider" if normalized_order_type == "delivery" else "shop"
            if normalized_tip_type not in {"", expected_tip_type}:
                raise HTTPException(status_code=400, detail="Invalid tip type")
            normalized_tip_type = expected_tip_type
        else:
            normalized_tip_type = ""

        tax_percent = max(0.0, min(100.0, float(getattr(settings, "tax_percent", 0) or 0)))
        vat_included = bool(getattr(settings, "vat_included", False))
        # Rewards/promos reduce ITEMS only. Service fee, small-order fee,
        # delivery/rider charge and tip are never discounted.
        items_after_discount = money(max(0.0, subtotal_amount - discount_amount))
        taxable_amount = money(
            max(
                0.0,
                items_after_discount + service_fee + small_order_fee + delivery_charge,
            )
        )
        if tax_percent > 0:
            if vat_included:
                tax_amount = money(taxable_amount - taxable_amount / (1 + tax_percent / 100))
                tax_added_to_total = 0.0
            else:
                tax_amount = money(taxable_amount * tax_percent / 100)
                tax_added_to_total = tax_amount
        else:
            tax_amount = 0.0
            tax_added_to_total = 0.0

        server_total = money(
            max(
                0.0,
                items_after_discount
                + service_fee
                + small_order_fee
                + delivery_charge
                + tax_added_to_total
                + tip_amount,
            )
        )

        # A stale checkout is refreshed instead of trusting client-provided money.
        try:
            submitted_total = float(data.total_amount)
        except (TypeError, ValueError):
            submitted_total = -1
        if not math.isfinite(submitted_total) or abs(submitted_total - server_total) > 0.15:
            raise HTTPException(
                status_code=400,
                detail=f"Order total changed. Correct total is AED {server_total:.2f}. Please refresh checkout.",
            )

        # ===== ONLINE -> CASH/CARD SWITCH SAFETY =====
        # A hosted Ziina checkout creates a payment_pending order before redirect.
        # If the customer uses Android/browser Back and then chooses Cash, the old
        # heuristic used to return that payment_pending row as a "duplicate".
        # That made the customer think Cash was placed while Kitchen saw nothing.
        # Before creating an offline-payment order, safely resolve a matching
        # pending Ziina attempt from THIS device/session.
        if payment_kind != "ziina":
            pending_since = datetime.now(timezone.utc) - timedelta(minutes=35)
            pending_ziina = None

            # Explicit order ID is strongest and also repairs pending orders
            # created by older app builds before Client Session markers existed.
            if data.replace_pending_payment_order_id is not None:
                explicit_pending = await db.execute(
                    select(Orders).where(
                        Orders.id == int(data.replace_pending_payment_order_id),
                        Orders.user_id == guest_user_id,
                        Orders.status == "payment_pending",
                        Orders.payment_method.ilike("Ziina Online%"),
                    ).limit(1)
                )
                pending_ziina = explicit_pending.scalar_one_or_none()
                # A changed cart must not permanently lock the customer out of
                # Cash/Card. The old hosted Ziina attempt belongs to this same
                # customer, so it is resolved below with
                # prepare_pending_order_for_offline_switch(). Active provider
                # intents are marked abandoned and auto-refunded if they ever
                # complete later.

            if pending_ziina is None:
                pending_query = await db.execute(
                    select(Orders).where(
                        Orders.user_id == guest_user_id,
                        Orders.items_json == canonical_items_json,
                        Orders.total_amount == server_total,
                        Orders.order_type == normalized_order_type,
                        Orders.status == "payment_pending",
                        Orders.payment_method.ilike("Ziina Online%"),
                        Orders.order_notes.contains(client_session_marker),
                        Orders.created_at >= pending_since,
                        *(([Orders.branch_id == branch.id]) if branch is not None else []),
                    ).order_by(desc(Orders.created_at)).limit(1)
                )
                pending_ziina = pending_query.scalar_one_or_none()

            if pending_ziina is not None:
                from routers.ziina_payments import prepare_pending_order_for_offline_switch

                switch_result = await prepare_pending_order_for_offline_switch(db, pending_ziina)
                if bool(switch_result.get("paid")):
                    # Payment already completed while the customer was navigating
                    # back. Never create a second Cash order.
                    return {
                        "success": True,
                        "order_id": pending_ziina.id,
                        "status": pending_ziina.status,
                        "payment_already_completed": True,
                        "duplicate_prevented": True,
                    }

        # ===== RATE LIMIT + DUPLICATE PREVENTION =====
        five_minutes_ago = datetime.now(timezone.utc) - timedelta(minutes=5)
        recent_count = await db.scalar(
            select(func.count(Orders.id)).where(
                Orders.user_id == guest_user_id,
                Orders.created_at >= five_minutes_ago,
                Orders.status.notin_(["cancelled", "expired"]),
            )
        )
        if int(recent_count or 0) >= 5:
            raise HTTPException(
                status_code=429,
                detail="Too many orders placed recently. Please wait a few minutes before ordering again.",
            )

        sixty_seconds_ago = datetime.now(timezone.utc) - timedelta(seconds=60)
        duplicate_check = await db.execute(
            select(Orders).where(
                Orders.user_id == guest_user_id,
                Orders.items_json == canonical_items_json,
                Orders.total_amount == server_total,
                Orders.order_type == normalized_order_type,
                Orders.payment_method == data.payment_method,
                Orders.order_notes.contains(client_session_marker),
                Orders.created_at >= sixty_seconds_ago,
                Orders.status.notin_(["cancelled", "expired"]),
                *(([Orders.branch_id == branch.id]) if branch is not None else []),
            ).order_by(desc(Orders.created_at)).limit(1)
        )
        existing_order = duplicate_check.scalar_one_or_none()
        if existing_order:
            return {
                "success": True,
                "order_id": existing_order.id,
                "status": existing_order.status,
                "duplicate_prevented": True,
            }

        # Ziina online orders must not reach Admin/Kitchen/Rider before payment.
        is_ziina_online = str(data.payment_method or "").strip().lower().startswith("ziina online")
        initial_status = "payment_pending" if is_ziina_online else "new"

        order = Orders(
            user_id=guest_user_id,
            customer_name=data.customer_name.strip(),
            customer_phone=account_phone,
            pickup_time="",
            order_notes=(
                f"{str(data.order_notes or '').strip()} | {client_session_marker}".strip(" |")
            ),
            payment_method=data.payment_method,
            order_type=normalized_order_type,
            customer_lat=float(data.customer_lat) if normalized_order_type == "delivery" else None,
            customer_lng=float(data.customer_lng) if normalized_order_type == "delivery" else None,
            customer_address=(
                str(data.customer_address or "").strip()
                or (f"GPS: {float(data.customer_lat):.6f},{float(data.customer_lng):.6f}" if normalized_order_type == "delivery" else "")
            ) if normalized_order_type == "delivery" else "",
            branch_id=branch.id if branch is not None else None,
            branch_name=branch.name if branch is not None else "",
            delivery_distance_km=delivery_distance_km if normalized_order_type == "delivery" else None,
            delivery_zone_name=delivery_zone_name if normalized_order_type == "delivery" else "",
            status=initial_status,
            total_amount=server_total,
            subtotal_amount=subtotal_amount,
            promo_code=promo_code,
            discount_type=discount_type,
            discount_percent=discount_percent,
            discount_amount=discount_amount,
            service_fee=service_fee,
            small_order_fee=small_order_fee,
            delivery_charge=delivery_charge,
            tax_amount=tax_amount,
            tip_amount=tip_amount,
            tip_type=normalized_tip_type,
            items_json=canonical_items_json,
        )
        db.add(order)
        await db.flush()

        # CRITICAL ONE-TIME REWARD CLAIM:
        # Claim by SQL WHERE status='available' in the SAME transaction as the order.
        # Even two taps/devices at the same moment cannot redeem the same reward twice.
        if selected_reward is not None:
            reward_status = "reserved" if initial_status == "payment_pending" else "redeemed"
            claim_result = await db.execute(
                update(Customer_rewards)
                .where(
                    Customer_rewards.id == int(selected_reward.id),
                    Customer_rewards.customer_id == int(customer_payload.get("sub")),
                    Customer_rewards.status == "available",
                    Customer_rewards.expires_at >= datetime.now(timezone.utc),
                )
                .values(
                    status=reward_status,
                    redeemed_order_id=order.id,
                    redeemed_at=(datetime.now(timezone.utc) if reward_status == "redeemed" else None),
                )
            )
            if int(claim_result.rowcount or 0) != 1:
                await db.rollback()
                raise HTTPException(
                    status_code=409,
                    detail="This reward was already used. Please choose another reward.",
                )

        await db.commit()
        await db.refresh(order)

        rider_assignment = None
        # For Ziina, rider assignment starts only after Ziina confirms payment.
        if normalized_order_type == "delivery" and initial_status == "new":
            try:
                rider_assignment = await auto_assign_order(db, order)
            except Exception:
                # The order itself is already committed. Rider availability must
                # never make a successful customer order disappear.
                logging.exception("Auto rider assignment failed for order %s", order.id)
                await db.rollback()

        return {
            "success": True,
            "order_id": order.id,
            "status": order.status,
            "branch": ({"id": branch.id, "name": branch.name} if branch is not None else None),
            "rider_assignment": rider_assignment,
            "pricing": {
                "subtotal": subtotal_amount,
                "discount": discount_amount,
                "reward_id": int(selected_reward.id) if selected_reward is not None else None,
                "reward_title": str(selected_reward.title) if selected_reward is not None else "",
                "service_fee": service_fee,
                "small_order_fee": small_order_fee,
                "delivery_charge": delivery_charge,
                "tax_amount": tax_amount,
                "vat_included": vat_included,
                "tip_amount": tip_amount,
                "total": server_total,
            },
        }
    except HTTPException:
        raise
    except Exception as exc:
        logging.exception("Failed to place order")
        await db.rollback()
        raise HTTPException(status_code=500, detail="Could not place order. Please try again.") from exc


class CancelOrderRequest(BaseModel):
    session_id: str
    reason: str


@router.post("/{order_id}/cancel")
async def cancel_order(
    order_id: int,
    data: CancelOrderRequest,
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    """Customer cancels only an order owned by their logged-in account/device."""
    try:
        customer_payload = decode_customer_token(get_bearer_token(authorization))
        customer_user_id = f"customer:{customer_payload.get('sub', '')}"
        # Strict privacy: cancellation is account-owned only.  Do not trust a
        # browser/device session id here because another customer may later use
        # the same device.
        result = await db.execute(
            select(Orders).where(
                Orders.id == order_id,
                Orders.user_id == customer_user_id,
            )
        )
        order = result.scalar_one_or_none()

        if not order:
            raise HTTPException(status_code=404, detail="Order not found")

        # Customer cancellation is intentionally hard-locked.
        # Once the shop accepts the order, only Admin/Kitchen can cancel it.
        allowed_statuses = ['new']

        if order.status not in allowed_statuses:
            status_msg = {
                'payment_pending': 'Online payment is still pending. Please manage it from the payment controls in My Orders.',
                'accepted': 'Your order has been accepted and is being processed.',
                'preparing': 'Your order is being prepared and cannot be cancelled.',
                'ready': 'Your order is ready for pickup and cannot be cancelled.',
                'completed': 'This order has already been completed.',
                'cancelled': 'This order is already cancelled.',
            }
            raise HTTPException(
                status_code=400,
                detail=status_msg.get(order.status, f"Cannot cancel order in '{order.status}' status.")
            )

        reason = ' '.join(str(data.reason or '').split()).strip()
        if len(reason) < 2:
            raise HTTPException(status_code=400, detail="Please select or enter a cancellation reason.")
        if len(reason) > 300:
            raise HTTPException(status_code=400, detail="Cancellation reason is too long.")

        order.status = 'cancelled'
        existing_notes = order.order_notes or ''
        separator = ' | ' if existing_notes else ''
        order.order_notes = f"{existing_notes}{separator}Cancelled by customer: {reason}"

        # Keep Rider app in sync immediately when the customer cancels.
        await cancel_order_assignments(db, order.id)

        await db.commit()
        return {"success": True, "message": "Order cancelled successfully"}
    except HTTPException:
        raise
    except Exception as e:
        logging.error(f"Failed to cancel order: {e}")
        await db.rollback()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/my-orders")
async def get_my_orders(
    session_id: Optional[str] = Query(default=None, min_length=8, max_length=120),
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    """Get only orders belonging to the logged-in customer account."""
    try:
        customer_payload = decode_customer_token(get_bearer_token(authorization))
        customer_user_id = f"customer:{customer_payload.get('sub', '')}"
        account_phone = normalize_phone(str(customer_payload.get("phone") or ""))

        # Strict privacy: never include guest/device ownership in My Orders.
        # A shared phone/tablet must not expose a previous customer's orders.
        ownership_filters = [Orders.user_id == customer_user_id]

        # Legacy recovery is allowed only by the phone stored in the signed
        # customer JWT. Strip common formatting in SQL and compare exact digits;
        # never use a partial/last-digits match.
        if account_phone:
            phone_digits = ''.join(ch for ch in account_phone if ch.isdigit())
            safe_variants = [phone_digits]
            if phone_digits.startswith('971') and len(phone_digits) >= 11:
                safe_variants.append('0' + phone_digits[3:])
            db_phone_digits = func.replace(
                func.replace(
                    func.replace(
                        func.replace(
                            func.replace(Orders.customer_phone, '+', ''),
                            ' ', '',
                        ),
                        '-', '',
                    ),
                    '(', '',
                ),
                ')', '',
            )
            ownership_filters.append(db_phone_digits.in_(safe_variants))
        from models.delivery_assignments import Delivery_assignments
        from models.riders import Riders

        result = await db.execute(
            select(Orders)
            .where(or_(*ownership_filters))
            .order_by(desc(Orders.created_at))
            .limit(50)
        )
        orders = result.scalars().all()

        items = []
        for order in orders:
            order_data = {
                "id": order.id,
                "customer_name": order.customer_name,
                "customer_phone": order.customer_phone,
                "estimated_time": order.pickup_time or "",
                "order_notes": public_order_notes(order.order_notes),
                "payment_method": order.payment_method,
                "order_type": getattr(order, "order_type", "pickup") or "pickup",
                "customer_lat": getattr(order, "customer_lat", None),
                "customer_lng": getattr(order, "customer_lng", None),
                "customer_address": getattr(order, "customer_address", "") or "",
                "branch_id": getattr(order, "branch_id", None),
                "branch_name": getattr(order, "branch_name", "") or "",
                "status": order.status,
                "total_amount": order.total_amount,
                "subtotal_amount": order.subtotal_amount or 0,
                "promo_code": order.promo_code or "",
                "discount_type": order.discount_type or "",
                "discount_percent": order.discount_percent or 0,
                "discount_amount": order.discount_amount or 0,
                "service_fee": order.service_fee or 0,
                "small_order_fee": order.small_order_fee or 0,
                "delivery_charge": order.delivery_charge or 0,
                "tax_amount": getattr(order, "tax_amount", 0) or 0,
                "tip_amount": order.tip_amount or 0,
                "tip_type": order.tip_type or "",
                "items_json": order.items_json,
                "created_at": order.created_at.isoformat() if order.created_at else None,
                "delivery_status": None,
                "rider_name": None,
                "rider_phone": None,
            }

            # Check if this order has a delivery assignment
            assignment_result = await db.execute(
                select(Delivery_assignments)
                .where(Delivery_assignments.order_id == order.id)
                .order_by(desc(Delivery_assignments.created_at))
                .limit(1)
            )
            assignment = assignment_result.scalar_one_or_none()

            if assignment:
                order_data["delivery_status"] = assignment.status
                # Only show rider contact info after pickup
                if assignment.status in ("picked_up", "on_the_way", "delivered"):
                    rider_result = await db.execute(
                        select(Riders).where(Riders.id == assignment.rider_id)
                    )
                    rider = rider_result.scalar_one_or_none()
                    if rider:
                        order_data["rider_name"] = rider.name
                        order_data["rider_phone"] = rider.phone

            items.append(order_data)

        return {"items": items}
    except HTTPException:
        raise
    except Exception as exc:
        logging.exception("Failed to get customer orders")
        raise HTTPException(status_code=500, detail="Could not load your orders. Please try again.") from exc

@router.get("/my-feedbacks")
async def get_my_feedbacks(
    authorization: Optional[str] = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
):
    """Return feedback order IDs owned by the logged-in customer."""
    try:
        from models.feedbacks import Feedbacks

        customer_payload = decode_customer_token(get_bearer_token(authorization))
        customer_user_id = f"customer:{customer_payload.get('sub', '')}"
        rows = (
            await db.execute(
                select(Feedbacks.order_id)
                .join(Orders, Orders.id == Feedbacks.order_id)
                .where(Orders.user_id == customer_user_id)
                .order_by(desc(Feedbacks.created_at))
                .limit(100)
            )
        ).scalars().all()
        return {"order_ids": [int(order_id) for order_id in rows if order_id is not None]}
    except HTTPException:
        raise
    except Exception as exc:
        logging.exception("Failed to load customer feedback history")
        raise HTTPException(status_code=500, detail="Could not load feedback history") from exc
