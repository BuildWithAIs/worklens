"""Build the code-native WorkLens monogram for Electron packaging."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parent.parent
out = root / 'build'
out.mkdir(exist_ok=True)
image = Image.new('RGBA', (1024, 1024))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((40, 40, 984, 984), radius=230, fill='#0f8478')
font = ImageFont.truetype('C:/Windows/Fonts/georgiab.ttf', 710)
draw.text((512, 486), 'W', font=font, anchor='mm', fill='#fffdfa')
image.save(out / 'icon.png')
image.save(out / 'icon.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
image.save(out / 'icon.icns')
