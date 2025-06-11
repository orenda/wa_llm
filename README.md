# WhatsApp Group Assistant Bot

A WhatsApp bot that can participate in group conversations, powered by AI. The bot monitors group messages and responds when mentioned.

## Features

- Automated group chat responses when mentioned
- Message history tracking and summarization
- Knowledge base integration for informed responses
- Support for various message types (text, media, links, etc.)
- Group management capabilities

## Prerequisites

- Docker and Docker Compose
- Python 3.12+
- PostgreSQL with pgvector extension
- Voyage AI API key
- WhatsApp account for the bot

## Setup

1. Clone the repository

2. Create a `.env` file in the src directory with the following variables:

```env
WHATSAPP_HOST=http://localhost:3000
WHATSAPP_BASIC_AUTH_USER=admin
WHATSAPP_BASIC_AUTH_PASSWORD=admin
VOYAGE_API_KEY=your_voyage_api_key
DB_URI=postgresql+asyncpg://user:password@localhost:5432/postgres
LOG_LEVEL=INFO
ANTHROPIC_API_KEY=your-key-here # You need to have a real anthropic key here, starts with sk-....
LOGFIRE_TOKEN=your-key-here # You need to have a real logfire key here
```

3. Start the services:
```bash
docker-compose up -d
```

4. Initialize the WhatsApp connection by scanning the QR code through the WhatsApp web interface.

## Usage

Mention the bot in a group message and include the word `bot` followed by a command. For example:

```text
@<your number> bot summarize
```
=======
Managed groups are flagged in the database. Only those groups will receive bot responses. 
1. Mark a WhatsApp group as managed in the database using `UPDATE "group" SET managed = true WHERE group_jid = '<jid>';`.

To trigger a reply you must mention the bot's phone number **and** include the word `bot` in the message.
 Once triggered you can ask for conversation summaries or query the knowledge base with commands such as `bot summarize` or `bot how do we ...`.

2. Mention the bot's phone number **and** include the word `bot` to activate it, for example:

   ```text
   @<bot-number> bot summarize
   ```

3. The bot can summarize the last 24 hours of chat or answer knowledge base questions when triggered.
## Developing

* install uv tools `uv sync --all-extras --active`
* run ruff (Python linter and code formatter) `ruff check` and `ruff format`
* check for types usage `pyright`
## Testing

Install dev dependencies and run the test suite after starting the supporting services:
```bash
uv sync --all-extras --dev
docker-compose up -d
pytest
```

Tests require the environment variables described in the Setup section. To generate coverage reports use:
```bash
uv run coverage run --source=pytest_evals -m pytest
uv run coverage xml
```


## Architecture

The project consists of several key components:

- FastAPI backend for webhook handling
- WhatsApp Web API client for message interaction
- PostgreSQL database with vector storage for knowledge base
- AI-powered message processing and response generation

## Key Files

- Main application: `app/main.py`
- WhatsApp client: `src/whatsapp/client.py`
- Message handler: `src/handler/__init__.py`
- Database models: `src/models/`

## Calendar Export

Events stored in the database can be exported to an iCalendar file. You can run
the standalone script:

```bash
python -m app.calendar
```

This writes `calendar.ics` in the current directory. When the FastAPI server is
running, the same content is available at `http://localhost:5001/calendar.ics`.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## License

[LICENSE](LICENSE)
