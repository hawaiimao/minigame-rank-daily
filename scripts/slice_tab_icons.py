"""One-shot: slice site/art/icon.jpg into 6 tab icons.

Output: site/icons/tab-1.png .. tab-6.png (transparent background).
Only run once; commit the resulting PNGs.
"""
from pathlib import Path
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "art" / "icon.jpg"
OUT = ROOT / "site" / "icons"
OUT.mkdir(parents=True, exist_ok=True)


def trim(im, bg=(240, 233, 214), tolerance=25):
    """Approximate: remove near-cream background, replace with alpha."""
    im = im.convert("RGBA")
    px = im.load()
    w, h = im.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if (abs(r - bg[0]) < tolerance
                    and abs(g - bg[1]) < tolerance
                    and abs(b - bg[2]) < tolerance):
                px[x, y] = (255, 255, 255, 0)
    # Auto-crop to non-transparent bbox.
    bbox = im.getbbox()
    if bbox:
        im = im.crop(bbox)
    return im


def main():
    im = Image.open(SRC).convert("RGBA")
    W, H = im.size
    # Manual layout — the poster has decorative header + 4 rows × 3 cols
    # of icons + a footer band. Estimate roughly.
    top = int(H * 0.10)
    bot = int(H * 0.86)
    grid_h = bot - top
    row_h = grid_h // 4
    col_w = W // 3

    idx = 0
    positions = []
    # Take first 2 rows (6 icons).
    for row in range(2):
        for col in range(3):
            x0 = col * col_w
            y0 = top + row * row_h
            x1 = x0 + col_w
            y1 = y0 + row_h
            positions.append((x0, y0, x1, y1))

    for i, box in enumerate(positions, start=1):
        crop = im.crop(box)
        trimmed = trim(crop)
        # Resize to a consistent output size (48x48 for retina icon size).
        trimmed.thumbnail((256, 256))  # keep decent quality
        out_path = OUT / f"tab-{i}.png"
        trimmed.save(out_path, "PNG")
        print(f"wrote {out_path}  size={trimmed.size}")


if __name__ == "__main__":
    main()
