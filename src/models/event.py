from datetime import datetime, timezone
from typing import Optional

from sqlmodel import SQLModel, Field, Column, DateTime


class Event(SQLModel, table=True):
    id: str = Field(primary_key=True)
    group_jid: Optional[str] = Field(
        default=None, max_length=255, foreign_key="group.group_jid"
    )
    message_id: Optional[str] = Field(
        default=None, max_length=255, foreign_key="message.message_id"
    )
    title: str
    start_time: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False),
        default_factory=lambda: datetime.now(timezone.utc),
    )
    end_time: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False),
        default_factory=lambda: datetime.now(timezone.utc),
    )
    location: Optional[str] = Field(default=None, max_length=255)


Event.model_rebuild()
