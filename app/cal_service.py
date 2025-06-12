import asyncio
from pathlib import Path

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from sqlmodel.ext.asyncio.session import AsyncSession
from ics import Calendar, Event as ICSEvent

from config import Settings
from models import Event


async def write_calendar(session: AsyncSession, path: Path) -> None:
    events = (await session.exec(Event.select())).all()  # type: ignore[arg-type]
    cal = Calendar()

    for event in events:
        ics_event = ICSEvent()
        ics_event.name = event.title
        ics_event.begin = event.start_time
        if event.end_time:
            ics_event.end = event.end_time
        if event.description:
            ics_event.description = event.description
        cal.events.add(ics_event)

    path.write_text(cal.serialize())


async def main() -> None:
    settings = Settings()
    engine = create_async_engine(settings.db_uri)
    async_session = async_sessionmaker(
        engine, expire_on_commit=False, class_=AsyncSession
    )

    async with async_session() as session:
        await write_calendar(session, Path("calendar.ics"))

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
