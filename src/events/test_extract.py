import pytest
from pydantic_ai import Agent
from datetime import datetime, timezone
from types import SimpleNamespace

from events.extract import parse_event
from models.event import Event


@pytest.mark.asyncio
async def test_parse_event_hebrew(monkeypatch):
    text = "היי, ב-1 בינואר 2025 בשעה 10:00 נפגש בקפה ביאליק להרצאה על בינה מלאכותית עד 12:00"
    expected = Event(
        id="e1",
        title="הרצאה על בינה מלאכותית",
        start_time=datetime(2025, 1, 1, 10, 0, tzinfo=timezone.utc),
        end_time=datetime(2025, 1, 1, 12, 0, tzinfo=timezone.utc),
        location="קפה ביאליק",
    )

    async def run(self, *_args, **_kwargs):
        return SimpleNamespace(data=expected)

    monkeypatch.setattr(Agent, "__init__", lambda self, *a, **k: None)
    monkeypatch.setattr(Agent, "run", run)

    event = await parse_event(text)
    assert event == expected

