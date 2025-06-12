import logging
from datetime import date, timedelta

from sqlmodel.ext.asyncio.session import AsyncSession
from voyageai.client_async import AsyncClient

from handler.router import Router
from handler.whatsapp_group_link_spam import WhatsappGroupLinkSpamHandler
from bot.zmanim_handler import (
    parse_zmanim_query,
    get_daily_zmanim,
    get_hebrew_date_string,
    format_zmanim_response,
)
from models import (
    WhatsAppWebhookPayload,
)
from whatsapp import WhatsAppClient
from .base_handler import BaseHandler

logger = logging.getLogger(__name__)


class MessageHandler(BaseHandler):
    def __init__(
        self,
        session: AsyncSession,
        whatsapp: WhatsAppClient,
        embedding_client: AsyncClient,
    ):
        self.router = Router(session, whatsapp, embedding_client)
        self.whatsapp_group_link_spam = WhatsappGroupLinkSpamHandler(
            session, whatsapp, embedding_client
        )
        super().__init__(session, whatsapp, embedding_client)

    async def __call__(self, payload: WhatsAppWebhookPayload):
        message = await self.store_message(payload)
        # ignore messages that don't exist or don't have text
        if not message or not message.text:
            return

        if message.sender_jid.endswith("@lid"):
            logging.info(
                f"Received message from {message.sender_jid}: {payload.model_dump_json()}"
            )

        # ignore messages from unmanaged groups
        if message and message.group and not message.group.managed:
            return

        query = parse_zmanim_query(message.text)
        if query:
            target_date = date.today()
            if query.get("target") == "tomorrow":
                target_date += timedelta(days=1)
            zmanim = get_daily_zmanim(target_date)
            hebrew_date = get_hebrew_date_string(target_date)
            response = format_zmanim_response(
                zmanim, hebrew_date, query["type"], query.get("zman")
            )
            await self.send_message(message.chat_jid, response, message.message_id)
            return

        bot_jid = await self.whatsapp.get_my_jid()
        if message.has_mentioned(bot_jid) and "bot" in message.text.lower():
            await self.router(message)

        # Handle whatsapp links in group
        if "https://chat.whatsapp.com/" in message.text:
            await self.whatsapp_group_link_spam(message)
