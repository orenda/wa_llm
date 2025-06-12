import pytest
from unittest.mock import AsyncMock

from handler.base_handler import BaseHandler
from models import Message, Sender, Event
from datetime import datetime, timezone
from test_utils.mock_session import mock_session  # noqa


@pytest.mark.asyncio
async def test_store_message_with_media_only(mock_session):
    handler = BaseHandler(mock_session, AsyncMock(), AsyncMock())
    handler.upsert = AsyncMock(side_effect=lambda m: m)
    msg = Message(
        message_id="media_only",
        chat_jid="123@g.us",
        sender_jid="u@s.whatsapp.net",
        media_url="http://example.com/image.jpg",
    )
    await handler.store_message(msg)
    mock_session.get.assert_any_call(Sender, msg.sender_jid)


@pytest.mark.asyncio
async def test_store_message_skips_incomplete_event(mock_session, monkeypatch):
    handler = BaseHandler(mock_session, AsyncMock(), AsyncMock())
    msg = Message(
        message_id="msg1",
        chat_jid="123@g.us",
        sender_jid="u@s.whatsapp.net",
        text="event text",
    )

    incomplete_event = Event(
        id="",
        title="",
        start_time=datetime.now(timezone.utc),
    )

    monkeypatch.setattr(
        "events.extract.parse_event", AsyncMock(return_value=incomplete_event)
    )
    handler.upsert = AsyncMock(side_effect=lambda m: m)

    await handler.store_message(msg)

    assert not any(
        isinstance(call.args[0], Event) for call in handler.upsert.call_args_list
    )
