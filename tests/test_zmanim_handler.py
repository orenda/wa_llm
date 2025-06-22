from datetime import date

import pytest

from bot.zmanim_handler import (
    get_daily_zmanim,
    parse_zmanim_query,
    get_hebrew_date_string,
)


@pytest.mark.parametrize(
    "query,expected",
    [
        (
            "מתי שקיעה?",
            {"type": "specific", "zman": "shkiat_hachama", "target": "today"},
        ),
        ("מה זמני היום", {"type": "all", "target": "today"}),
        (
            "מחר עלות",
            {"type": "specific", "zman": "alot_hashachar", "target": "tomorrow"},
        ),
        ("מתי זריחה?", {"type": "specific", "zman": "netz_hachama", "target": "today"}),
        (
            "when is sunset?",
            {"type": "specific", "zman": "shkiat_hachama", "target": "today"},
        ),
        (
            "sunrise tomorrow",
            {"type": "specific", "zman": "netz_hachama", "target": "tomorrow"},
        ),
        (
            "all zmanim",
            {"type": "all", "target": "today"},
        ),
    ],
)
def test_parse_zmanim_query(query, expected):
    assert parse_zmanim_query(query) == expected


def test_get_daily_zmanim_sample_dates():
    data = get_daily_zmanim(date(2025, 6, 12))
    assert "netz_hachama" in data
    data = get_daily_zmanim(date(2025, 1, 15))
    assert "shkiat_hachama" in data


def test_get_hebrew_date_string():
    result = get_hebrew_date_string(date(2025, 6, 12))
    assert "📅" in result
