"""Helpers for keeping internal payment/session markers out of customer/staff notes."""

import re

_ZIINA_INTENT = re.compile(r"^Ziina Payment Intent:\s*[A-Za-z0-9_-]+$", re.IGNORECASE)
_ZIINA_REFUND = re.compile(r"^Ziina Refund:\s*.+$", re.IGNORECASE)
_ZIINA_ABANDONED = re.compile(r"^Ziina Payment Abandoned:\s*.+$", re.IGNORECASE)
_ZIINA_FEE = re.compile(r"^Ziina Fee:\s*\d+$", re.IGNORECASE)
_CLIENT_SESSION = re.compile(r"^Client Session:\s*[A-Za-z0-9_-]{8,120}$", re.IGNORECASE)


def public_order_notes(value: object) -> str:
    parts = [part.strip() for part in str(value or "").split("|")]
    visible = [
        part
        for part in parts
        if part
        and not _ZIINA_INTENT.match(part)
        and not _ZIINA_REFUND.match(part)
        and not _ZIINA_ABANDONED.match(part)
        and not _ZIINA_FEE.match(part)
        and not _CLIENT_SESSION.match(part)
    ]
    return " | ".join(visible)
