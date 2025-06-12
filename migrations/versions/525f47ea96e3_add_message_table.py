"""add message table

Revision ID: 525f47ea96e3
Revises: f26c6bacce0b
Create Date: 2025-06-12 00:27:09.351610

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "525f47ea96e3"
down_revision: Union[str, None] = "f26c6bacce0b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "message",
        sa.Column("message_id", sa.String(length=255), primary_key=True),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False),
        sa.Column("text", sa.Text(), nullable=True),
        sa.Column("media_url", sa.String(length=255), nullable=True),
        sa.Column("chat_jid", sa.String(length=255), nullable=False),
        sa.Column(
            "sender_jid",
            sa.String(length=255),
            sa.ForeignKey("sender.jid"),
            nullable=False,
        ),
        sa.Column(
            "group_jid",
            sa.String(length=255),
            sa.ForeignKey("group.group_jid"),
            nullable=True,
        ),
        sa.Column("reply_to_id", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("message")
