import pytest
from unittest.mock import AsyncMock

from handler.base_handler import BaseHandler
from models import Message, Sender
from test_utils.mock_session import mock_session  # noqa


@pytest.mark.asyncio
async def test_store_message_with_media_only(mock_session):
    handler = BaseHandler(mock_session, AsyncMock(), AsyncMock())
    msg = Message(
        message_id="media_only",
        chat_jid="123@g.us",
        sender_jid="u@s.whatsapp.net",
        media_url="http://example.com/image.jpg",
    )
    await handler.store_message(msg)
    mock_session.get.assert_any_call(Sender, msg.sender_jid)
