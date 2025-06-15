import sqlmodel

"""merge heads after parallel migrations

Revision ID: 90c4c75eaaf6
Revises: 5a9be1edde3d, eaa96b223b1a
Create Date: 2025-06-15 16:53:13.343143

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '90c4c75eaaf6'
down_revision: Union[str, None] = ('5a9be1edde3d', 'eaa96b223b1a')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
