"""add events table

Revision ID: 854c7f4bb0c1
Revises: f26c6bacce0b
Create Date: 2025-06-11 18:12:33.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "854c7f4bb0c1"
down_revision: Union[str, None] = "f26c6bacce0b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "event",
        sa.Column("id", sa.String(length=255), primary_key=True),
        sa.Column("group_jid", sa.String(length=255), sa.ForeignKey("group.group_jid"), nullable=True),
        sa.Column("message_id", sa.String(length=255), sa.ForeignKey("message.message_id"), nullable=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("start_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_time", sa.DateTime(timezone=True), nullable=False),
        sa.Column("location", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("event")
