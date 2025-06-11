from datetime import datetime, timezone
from typing import Optional

from sqlmodel import SQLModel, Field, Column, DateTime

class BaseEvent(SQLModel):
    id: str = Field(primary_key=True, max_length=255)
    title: str
    start_time: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True), nullable=False),
    )
    end_time: Optional[datetime] = Field(
        default=None, sa_column=Column(DateTime(timezone=True))
    )
    description: Optional[str] = None
    group_jid: Optional[str] = Field(
        default=None, foreign_key="group.group_jid", max_length=255
    )


class Event(BaseEvent, table=True):
    pass
