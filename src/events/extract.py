from __future__ import annotations

import logging
from typing import Optional

from pydantic_ai import Agent
from pydantic_ai.agent import AgentRunResult

from models.event import Event

logger = logging.getLogger(__name__)


async def parse_event(text: str) -> Optional[Event]:
    """Parse event details from free text using an LLM.

    Returns ``None`` when no event is detected.
    """
    if not text:
        return None

    agent = Agent(
        model="anthropic:claude-4-sonnet-20250514",
        system_prompt="""Extract meeting or event details from the following message.\n"
        "If no event information is present return null.\n"
        "Respond in JSON following the Event schema.""",
        result_type=Event,
        retries=3,
    )

    try:
        result: AgentRunResult[Event] = await agent.run(text)
        return result.data
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("parse_event failed: %s", exc)
        return None
