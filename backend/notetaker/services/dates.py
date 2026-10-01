from dataclasses import dataclass
from datetime import datetime

import dateparser
from django.utils import timezone


TIME_ALIASES = {
    "de manhã": "09:00",
    "ao final da manhã": "12:00",
    "de tarde": "14:00",
    "ao final da tarde": "17:00",
    "in the morning": "09:00",
    "at the end of the morning": "12:00",
    "in the afternoon": "14:00",
    "at the end of the afternoon": "17:00",
}


@dataclass(frozen=True)
class ParsedDate:
    value: datetime | None
    ambiguous: bool


def parse_spoken_date(phrase: str, relative_to: datetime | None = None) -> ParsedDate:
    """Resolve supported relative phrases while flagging missing calendar context."""
    if not phrase.strip():
        return ParsedDate(None, True)

    normalized = phrase.casefold().strip()
    replacement = next((time for label, time in TIME_ALIASES.items() if label in normalized), None)
    has_day_context = any(
        token in normalized
        for token in (
            "hoje",
            "amanhã",
            "segunda",
            "terça",
            "quarta",
            "quinta",
            "sexta",
            "sábado",
            "domingo",
            "today",
            "tomorrow",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
            "friday",
            "saturday",
            "sunday",
        )
    )
    if replacement:
        for label in TIME_ALIASES:
            normalized = normalized.replace(label, replacement)
    base = relative_to or timezone.now()
    value = dateparser.parse(
        normalized,
        languages=["pt", "en"],
        settings={
            "RELATIVE_BASE": base,
            "RETURN_AS_TIMEZONE_AWARE": True,
            "TIMEZONE": "Europe/Lisbon",
            "PREFER_DATES_FROM": "future",
        },
    )
    return ParsedDate(value, value is None or (replacement is not None and not has_day_context))
