import asyncio
from pathlib import Path
from typing import Optional

import pytesseract
from PIL import Image
from whatsapp import WhatsAppClient
import io


async def _download_image(client: WhatsAppClient, path: str) -> bytes:
    response = await client.client.get(path)
    response.raise_for_status()
    return response.content


async def extract_text(media_path: str, lang: str = "heb") -> str:
    """Extract text from an image using Tesseract.

    If ``media_path`` does not point to a local file it will be fetched using
    :class:`WhatsAppClient` before running OCR.
    """
    data: Optional[bytes] = None

    file_path = Path(media_path)
    if file_path.exists():
        data = file_path.read_bytes()
    else:
        async with WhatsAppClient() as client:
            # If the provided path is relative, prepend a slash so WhatsApp
            # server treats it as absolute.
            url = (
                media_path
                if media_path.startswith("http")
                else f"/{media_path.lstrip('/')}"
            )
            data = await _download_image(client, url)

    image = Image.open(io.BytesIO(data))
    text = await asyncio.to_thread(pytesseract.image_to_string, image, lang=lang)
    return text.strip()
