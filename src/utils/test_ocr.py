import pytest
from PIL import Image, ImageDraw, ImageFont
from utils.ocr import extract_text


@pytest.mark.asyncio
async def test_extract_text(tmp_path):
    # Create a small image with Hebrew text
    img_path = tmp_path / "heb.png"
    img = Image.new("RGB", (100, 50), "white")
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 24)
    draw.text((5, 5), "שלום", fill="black", font=font)
    img.save(img_path)

    result = await extract_text(str(img_path))
    assert "שלום" in result
