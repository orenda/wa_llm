"""Utilities for parsing and answering zmanim queries."""

from __future__ import annotations

import re
from datetime import date, datetime, timedelta, time, timezone
from functools import lru_cache
from math import sin, cos, tan, acos, atan, radians, degrees, floor, asin
from zoneinfo import ZoneInfo

from config import LOCATION_CONFIG

try:
    from pyzmanim.zmanim_calendar import ZmanimCalendar
    from pyzmanim.util import GeoLocation
except Exception:  # pragma: no cover - library optional in tests
    ZmanimCalendar = None
    GeoLocation = None

try:
    from hdate import HDate, Location as HLocation
    from hdate.hebrew_date_formatter import HebrewDateFormatter
except Exception:  # pragma: no cover - library optional in tests
    HDate = None
    HLocation = None
    HebrewDateFormatter = None


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


def _basic_sun_time(
    d: date, latitude: float, longitude: float, tz: str, sunrise: bool
) -> datetime:
    """Approximate sunrise/sunset using NOAA algorithm (used if pyzmanim is not installed)."""
    n = d.timetuple().tm_yday
    lng_hour = longitude / 15.0
    t = n + ((6 - lng_hour) / 24 if sunrise else (18 - lng_hour) / 24)
    m = (0.9856 * t) - 3.289
    L = m + 1.916 * sin(radians(m)) + 0.020 * sin(radians(2 * m)) + 282.634
    L = L % 360
    RA = degrees(atan(0.91764 * tan(radians(L))))
    RA = RA % 360
    Lquadrant = floor(L / 90) * 90
    RAquadrant = floor(RA / 90) * 90
    RA += Lquadrant - RAquadrant
    RA /= 15
    sin_dec = 0.39782 * sin(radians(L))
    cos_dec = cos(asin(sin_dec))
    cos_h = (cos(radians(90.833)) - (sin_dec * sin(radians(latitude)))) / (
        cos_dec * cos(radians(latitude))
    )
    if cos_h > 1 or cos_h < -1:
        raise ValueError("Sun never rises or sets on this date at this location")
    if sunrise:
        H = 360 - degrees(acos(cos_h))
    else:
        H = degrees(acos(cos_h))
    H /= 15
    T = H + RA - (0.06571 * t) - 6.622
    UT = (T - lng_hour) % 24
    hour = int(UT)
    minute = int((UT - hour) * 60)
    second = int((((UT - hour) * 60) - minute) * 60)
    dt_utc = datetime.combine(d, time(hour, minute, second, tzinfo=timezone.utc))
    return dt_utc.astimezone(ZoneInfo(tz))


@lru_cache(maxsize=4)
def get_daily_zmanim(target_date: date) -> dict:
    """Return a dictionary of calculated zmanim for the given date."""
    tz = LOCATION_CONFIG["timezone"]
    if ZmanimCalendar and GeoLocation:
        loc = GeoLocation(
            LOCATION_CONFIG["name"],
            LOCATION_CONFIG["latitude"],
            LOCATION_CONFIG["longitude"],
            ZoneInfo(tz),
        )
        cal = ZmanimCalendar(loc)
        cal.set_date(target_date)
        sunrise = cal.get_sunrise()  # type: ignore[attr-defined]
        sunset = cal.get_sunset()  # type: ignore[attr-defined]
    else:  # pragma: no cover - fallback for tests without pyzmanim
        sunrise = _basic_sun_time(
            target_date,
            LOCATION_CONFIG["latitude"],
            LOCATION_CONFIG["longitude"],
            tz,
            True,
        )
        sunset = _basic_sun_time(
            target_date,
            LOCATION_CONFIG["latitude"],
            LOCATION_CONFIG["longitude"],
            tz,
            False,
        )

    dawn = sunrise - timedelta(minutes=72)
    nightfall = sunset + timedelta(minutes=18)
    hour_ma = (nightfall - dawn) / 12
    hour_gra = (sunset - sunrise) / 12

    return {
        "alot_hashachar": dawn,
        "netz_hachama": sunrise,
        "sof_zman_shema_ma": dawn + 3 * hour_ma,
        "sof_zman_shema_gra": sunrise + 3 * hour_gra,
        "sof_zman_tefila_ma": dawn + 4 * hour_ma,
        "sof_zman_tefila_gra": sunrise + 4 * hour_gra,
        "chatzot": sunrise + 6 * hour_gra,
        "mincha_gedola": sunrise + 6.5 * hour_gra,
        "plag_hamincha": sunrise + 10.75 * hour_gra,
        "shkiat_hachama": sunset,
        "tzet_hakochavim_18": nightfall,
        "tzet_hakochavim_rt": sunset + timedelta(minutes=72),
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
