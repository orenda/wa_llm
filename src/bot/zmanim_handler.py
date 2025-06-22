"""Utilities for parsing and answering zmanim queries."""

from __future__ import annotations

import logging
import os
import re
from datetime import date, datetime
from functools import lru_cache

from config import LOCATION_CONFIG
from pydantic import BaseModel, Field
from pydantic_ai import Agent


logger = logging.getLogger(__name__)

try:
    from hdate import HDate as _HDate, Location as HLocation, Zmanim as HZmanim
except Exception:
    try:  # hdate >=1.1 dropped HDate in favour of HebrewDate
        from hdate import HebrewDate as _HDate, Location as HLocation, Zmanim as HZmanim
    except Exception as exc:  # pragma: no cover - library optional in tests
        _HDate = None
        HLocation = None
        HZmanim = None
        logger.warning("Failed to import hdate core modules: %s", exc)

HDate = _HDate

try:  # HebrewDateFormatter was introduced in newer versions
    from hdate.hebrew_date_formatter import HebrewDateFormatter
except Exception as exc:  # pragma: no cover - optional component
    HebrewDateFormatter = None
    logger.warning("Failed to import HebrewDateFormatter: %s", exc)


WEEKDAYS = [
    "יום שני",
    "יום שלישי",
    "יום רביעי",
    "יום חמישי",
    "יום שישי",
    "יום שבת",
    "יום ראשון",
]
HEBREW_MONTHS = {
    1: "ניסן",
    2: "אייר",
    3: "סיוון",
    4: "תמוז",
    5: "אב",
    6: "אלול",
    7: "תשרי",
    8: "חשוון",
    9: "כסלו",
    10: "טבת",
    11: "שבט",
    12: "אדר א׳",
    13: "אדר ב׳",
}


# ---------------------------------------------------------------------------
# Calculation helpers
# ---------------------------------------------------------------------------


@lru_cache(maxsize=4)
def get_daily_zmanim(target_date: date) -> dict:
    """Return a dictionary of calculated zmanim for the given date."""

    if not (HZmanim and HLocation):
        logging.warning("hdate library not available")
        raise RuntimeError("zmanim data unavailable")

    loc = HLocation(
        LOCATION_CONFIG["name"],
        LOCATION_CONFIG["latitude"],
        LOCATION_CONFIG["longitude"],
        LOCATION_CONFIG["timezone"],
    )
    z = HZmanim(target_date, location=loc)
    data = z.zmanim

    key_map = {
        "alot_hashachar": ["alot_hashachar", "first_light"],
        "netz_hachama": ["netz_hachama", "sunrise"],
        "sof_zman_shema_ma": ["sof_zman_shema_mga", "shema_eot_mga"],
        "sof_zman_shema_gra": ["sof_zman_shema_gra", "shema_eot_gra"],
        "sof_zman_tefila_ma": ["sof_zman_tfilla_mga", "tefila_eot_mga"],
        "sof_zman_tefila_gra": ["sof_zman_tfilla_gra", "tefila_eot_gra"],
        "chatzot": ["chatzot_hayom", "midday"],
        "mincha_gedola": ["mincha_gedola", "big_mincha"],
        "plag_hamincha": ["plag_hamincha", "plag_mincha"],
        "shkiat_hachama": ["shkia", "sunset"],
        "tzet_hakochavim_18": ["tset_hakohavim", "stars_out"],
        "tzet_hakochavim_rt": ["tset_hakohavim_rabeinu_tam", "night_by_rabbeinu_tam"],
    }

    result = {}
    for target, options in key_map.items():
        for opt in options:
            if opt in data:
                result[target] = data[opt].local
                break

    return result


# ---------------------------------------------------------------------------
# Formatting
# ---------------------------------------------------------------------------


def _hebrew_date(target_date: date) -> tuple[str, str]:
    """Return weekday and hebrew date strings."""
    if HDate and HebrewDateFormatter and HLocation:
        loc = HLocation(
            LOCATION_CONFIG["name"],
            LOCATION_CONFIG["latitude"],
            LOCATION_CONFIG["longitude"],
            LOCATION_CONFIG["timezone"],
        )
        hd = HDate(target_date, location=loc)
        formatter = HebrewDateFormatter(locale="he")
        hebrew = formatter.format(hd)  # type: ignore[attr-defined]
        weekday = formatter.format_weekday(hd.weekday())  # type: ignore[attr-defined]
    else:  # pragma: no cover - simplified fallback
        weekday = WEEKDAYS[target_date.weekday()]
        hebrew = target_date.strftime("%d/%m/%Y")
    return weekday, hebrew


def get_hebrew_date_string(target_date: date) -> str:
    """Return formatted Hebrew date header string."""
    weekday, hebrew = _hebrew_date(target_date)
    greg = target_date.strftime("%d %B %Y")
    if not (HDate and HebrewDateFormatter and HLocation):
        return f"📅 מצטער, אינני יכול להציג תאריך עברי כעת. ({greg})"
    return f"📅 יום {weekday}, {hebrew} ({greg})"


# ---------------------------------------------------------------------------
# Regex Parsing
# ---------------------------------------------------------------------------

ZMAN_KEYWORDS = {
    "alot_hashachar": r"עלות|first\s*light|dawn|alot",
    "netz_hachama": r"הנץ|זריחה|sunrise",
    "sof_zman_shema": r"שמע|shema",
    "sof_zman_tefila": r"תפילה|tefila|prayer",
    "chatzot": r"חצות|midday|chatz(?:o|)t(?:os)?",
    "mincha_gedola": r"מנחה גדולה|big mincha|mincha gedola",
    "plag_hamincha": r"פלג|plag",
    "shkiat_hachama": r"שקיעה|sunset",
    "tzet_hakochavim": r"צאת הכוכבים|nightfall|stars",
    "all": r"זמני היום|כל הזמנים|זמנים|zmanim",
}

TOMORROW_RE = re.compile(r"\b(?:מחר|tomorrow)\b", re.I)


def parse_zmanim_query(message_text: str) -> dict | None:
    """Detect if the message is requesting zmanim information."""
    text = message_text.strip().lower()
    target = "tomorrow" if TOMORROW_RE.search(text) else "today"

    if re.search(ZMAN_KEYWORDS["all"], text):
        return {"type": "all", "target": target}

    for key, pattern in ZMAN_KEYWORDS.items():
        if key == "all":
            continue
        if re.search(pattern, text):
            return {"type": "specific", "zman": key, "target": target}

    return None


class _LlmZmanimQuery(BaseModel):
    """Schema for LLM-based zmanim intent extraction."""

    type: str = Field(
        description="'all' for the full list, 'specific' for a single zman, 'none' otherwise"
    )
    zman: str | None = Field(
        default=None,
        description="Name of the zman being requested if type is 'specific'",
    )
    target: str = Field(default="today", description="Day requested: today or tomorrow")


async def parse_zmanim_query_llm(message_text: str) -> dict | None:
    """Use a language model to parse zmanim queries."""

    if not os.getenv("ENABLE_ZMANIM_LLM"):
        return None

    agent = Agent(
        model="anthropic:claude-4-sonnet-20250514",
        system_prompt="""Determine if the user is asking about zmanim times.
Return a JSON object describing the request with these fields:
- type: 'all', 'specific', or 'none'.
- zman: one of alot_hashachar, netz_hachama, sof_zman_shema,
  sof_zman_tefila, chatzot, mincha_gedola, plag_hamincha,
  shkiat_hachama, tzet_hakochavim. Only set when type='specific'.
- target: 'today' or 'tomorrow'. Default is today.
If the user is not asking about zmanim, respond with type='none'.""",
        output_type=_LlmZmanimQuery,
    )

    try:
        res = await agent.run(message_text)
    except Exception as exc:  # pragma: no cover - network issues
        logger.warning("zmanim LLM parsing failed: %s", exc)
        return None

    data = res.data
    if data.type in {"all", "specific"}:
        return {
            "type": data.type,
            "zman": data.zman,
            "target": data.target,
        }
    return None


# ---------------------------------------------------------------------------
# Response Formatting
# ---------------------------------------------------------------------------


def _format_time(dt: datetime) -> str:
    return dt.strftime("%H:%M")


def format_zmanim_response(
    zmanim_data: dict, hebrew_date_str: str, query_type: str, zman: str | None = None
) -> str:
    """Create a WhatsApp-ready Hebrew string from zmanim data."""
    if query_type == "specific" and zman:
        label_map = {
            "alot_hashachar": "🌅 עלות השחר",
            "netz_hachama": "☀️ הנץ החמה",
            "sof_zman_shema": "📖 סוף זמן קש",
            "sof_zman_tefila": "🙏 סוף זמן תפילה",
            "chatzot": "🕛 חצות היום",
            "mincha_gedola": "🌇 מנחה גדולה",
            "plag_hamincha": "🌇 פלג המנחה",
            "shkiat_hachama": "🌆 שקיעת החמה",
            "tzet_hakochavim": "🌃 צאת הכוכבים",
        }
        time_key = {
            "sof_zman_shema": "sof_zman_shema_gra",
            "sof_zman_tefila": "sof_zman_tefila_gra",
            "tzet_hakochavim": "tzet_hakochavim_18",
        }.get(zman, zman)
        val = zmanim_data.get(time_key)
        if not val:
            return ""
        return f"{hebrew_date_str}\n\n{label_map.get(zman, zman)} בלוד: {_format_time(val)}"

    # full list
    lines = [
        hebrew_date_str,
        "",
        "*זמני היום ההלכתיים ללוד:*",
        "",
        f"🌅 עלות השחר: {_format_time(zmanim_data['alot_hashachar'])}",
        f"☀️ הנץ החמה: {_format_time(zmanim_data['netz_hachama'])}",
        "",
        f'📖 סוף זמן ק"ש (מ"א): {_format_time(zmanim_data["sof_zman_shema_ma"])}',
        f'📖 סוף זמן ק"ש (גר"א): {_format_time(zmanim_data["sof_zman_shema_gra"])}',
        "",
        f'🙏 סוף זמן תפילה (מ"א): {_format_time(zmanim_data["sof_zman_tefila_ma"])}',
        f'🙏 סוף זמן תפילה (גר"א): {_format_time(zmanim_data["sof_zman_tefila_gra"])}',
        "",
        f"🕛 חצות היום: {_format_time(zmanim_data['chatzot'])}",
        "",
        f"🌇 מנחה גדולה: {_format_time(zmanim_data['mincha_gedola'])}",
        f"🌇 פלג המנחה: {_format_time(zmanim_data['plag_hamincha'])}",
        "",
        f"🌆 שקיעת החמה: {_format_time(zmanim_data['shkiat_hachama'])}",
        "",
        f"🌃 צאת הכוכבים (18 דק'): {_format_time(zmanim_data['tzet_hakochavim_18'])}",
        f'🌃 צאת הכוכבים (ר"ת): {_format_time(zmanim_data["tzet_hakochavim_rt"])}',
    ]
    return "\n".join(lines)
