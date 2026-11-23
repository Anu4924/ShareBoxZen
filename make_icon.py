import os
from PIL import Image, ImageDraw

def create_icon(output_path):
    sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    images = []

    for size in sizes:
        w, h = size
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        # Padding
        p = max(1, int(w * 0.05))
        box = [p, p, w - p - 1, h - p - 1]

        # Draw dark graphite circle background
        draw.ellipse(box, fill=(27, 27, 27, 255), outline=(214, 184, 121, 255), width=max(1, int(w * 0.06)))

        # Center zen dot / transfer symbol
        cx, cy = w / 2, h / 2
        r = w * 0.28
        inner_box = [cx - r, cy - r, cx + r, cy + r]
        draw.ellipse(inner_box, fill=(214, 184, 121, 230))

        # White inner core / arrow accent
        cr = w * 0.12
        core_box = [cx - cr, cy - cr, cx + cr, cy + cr]
        draw.ellipse(core_box, fill=(255, 255, 255, 255))

        images.append(img)

    # Save multi-size icon
    images[0].save(
        output_path,
        format="ICO",
        sizes=[(im.width, im.height) for im in images],
        append_images=images[1:]
    )
    print(f"Created high-res icon: {output_path}")

if __name__ == "__main__":
    ico_path = r"c:\Users\anu49\Downloads\Documents\ShareBoxZen\ShareBoxZen.ico"
    create_icon(ico_path)
