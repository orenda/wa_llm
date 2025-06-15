"""make end_time nullable, add description column

Revision ID: eaa96b223b1a
Revises: 854c7f4bb0c1
Create Date: 2025-06-15 00:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "eaa96b223b1a"
down_revision: Union[str, None] = "854c7f4bb0c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("event", sa.Column("description", sa.Text(), nullable=True))
    op.alter_column(
        "event",
        "end_time",
        existing_type=sa.DateTime(timezone=True),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "event",
        "end_time",
        existing_type=sa.DateTime(timezone=True),
        nullable=False,
    )
    op.drop_column("event", "description")
