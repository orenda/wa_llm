"""Utilities for parsing and answering zmanim queries."""

from __future__ import annotations

import logging
import re
from datetime import date, datetime
from functools import lru_cache

import logging
from config import LOCATION_CONFIG


logger = logging.getLogger(__name__)

try:

    from hdate import HDate, Location as HLocation, Zmanim as HZmanim

    from hdate.hebrew_date_formatter import HebrewDateFormatter
except Exception as exc:  # pragma: no cover - library optional in tests
    HDate = None
    HLocation = None
    HZmanim = None
    HebrewDateFormatter = None
    logger.warning(
        "Failed to import hdate, Hebrew date support disabled: %s", exc
    )


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

    return {
        "alot_hashachar": data["alot_hashachar"].local,
        "netz_hachama": data["netz_hachama"].local,
        "sof_zman_shema_ma": data["sof_zman_shema_mga"].local,
        "sof_zman_shema_gra": data["sof_zman_shema_gra"].local,
        "sof_zman_tefila_ma": data["sof_zman_tfilla_mga"].local,
        "sof_zman_tefila_gra": data["sof_zman_tfilla_gra"].local,
        "chatzot": data["chatzot_hayom"].local,
        "mincha_gedola": data["mincha_gedola"].local,
        "plag_hamincha": data["plag_hamincha"].local,
        "shkiat_hachama": data["shkia"].local,
        "tzet_hakochavim_18": data["tset_hakohavim"].local,
        "tzet_hakochavim_rt": data["tset_hakohavim_rabeinu_tam"].local,
    }


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
        weekday = [
            "ראשון",
            "שני",
            "שלישי",
            "רביעי",
            "חמישי",
            "שישי",
            "שבת",
        ][target_date.weekday()]
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
    "alot_hashachar": r"עלות",
    "netz_hachama": r"הנץ|זריחה",
    "sof_zman_shema": r"שמע",
    "sof_zman_tefila": r"תפילה",
    "chatzot": r"חצות",
    "mincha_gedola": r"מנחה גדולה",
    "plag_hamincha": r"פלג",
    "shkiat_hachama": r"שקיעה",
    "tzet_hakochavim": r"צאת הכוכבים",
    "all": r"זמני היום|כל הזמנים|זמנים",
}

TOMORROW_RE = re.compile(r"\bמחר\b")


def parse_zmanim_query(message_text: str) -> dict | None:
    """Detect if the message is requesting zmanim information."""
    text = message_text.strip()
    target = "tomorrow" if TOMORROW_RE.search(text) else "today"

    if re.search(ZMAN_KEYWORDS["all"], text):
        return {"type": "all", "target": target}

    for key, pattern in ZMAN_KEYWORDS.items():
        if key == "all":
            continue
        if re.search(pattern, text):
            return {"type": "specific", "zman": key, "target": target}

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
