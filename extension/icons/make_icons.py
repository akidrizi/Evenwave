"""Generates the Evenwave icon set (recreation of the provided artwork:
gradient blue->purple squircle, white equalizer bars, center balance knob).
Run once with Pillow+numpy; output PNGs are what ships, this script is not
part of the extension itself.
"""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
BRAND_A = (45, 100, 255)     # top-left blue
BRAND_B = (140, 60, 240)     # bottom-right purple

def diagonal_gradient(size, c1, c2):
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    t = (x + y) / (2 * (size - 1))
    t = t[..., None]
    c1 = np.array(c1, dtype=np.float64)
    c2 = np.array(c2, dtype=np.float64)
    rgb = (c1 * (1 - t) + c2 * t).astype(np.uint8)
    alpha = np.full((size, size, 1), 255, dtype=np.uint8)
    return Image.fromarray(np.concatenate([rgb, alpha], axis=2), 'RGBA')

def rounded_mask(size, radius):
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def build_icon():
    bg = diagonal_gradient(SIZE, BRAND_A, BRAND_B)
    mask = rounded_mask(SIZE, int(SIZE * 0.225))
    canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    canvas.paste(bg, (0, 0), mask)

    draw = ImageDraw.Draw(canvas)
    cx = SIZE / 2
    # 9 symmetric bars, center tallest
    heights = [0.16, 0.34, 0.50, 0.68, 0.86, 0.68, 0.50, 0.34, 0.16]
    n = len(heights)
    bar_w = SIZE * 0.052
    gap = SIZE * 0.028
    total_w = n * bar_w + (n - 1) * gap
    start_x = cx - total_w / 2
    for i, hfrac in enumerate(heights):
        bar_h = SIZE * hfrac
        x0 = start_x + i * (bar_w + gap)
        x1 = x0 + bar_w
        y0 = SIZE / 2 - bar_h / 2
        y1 = SIZE / 2 + bar_h / 2
        draw.rounded_rectangle([x0, y0, x1, y1], radius=bar_w / 2, fill=(255, 255, 255, 255))

    # soft shadow under the knob
    knob_d = SIZE * 0.30
    shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sx0, sy0 = cx - knob_d / 2, SIZE / 2 - knob_d / 2 + SIZE * 0.02
    sd.ellipse([sx0, sy0, sx0 + knob_d, sy0 + knob_d], fill=(10, 10, 30, 130))
    shadow = shadow.filter(ImageFilter.GaussianBlur(SIZE * 0.02))
    canvas = Image.alpha_composite(canvas, shadow)

    draw = ImageDraw.Draw(canvas)
    kx0, ky0 = cx - knob_d / 2, SIZE / 2 - knob_d / 2
    draw.ellipse([kx0, ky0, kx0 + knob_d, ky0 + knob_d], fill=(255, 255, 255, 255))

    return canvas

if __name__ == '__main__':
    master = build_icon()
    master.save('icon512.png')
    for s in (128, 48, 32, 16):
        master.resize((s, s), Image.LANCZOS).save(f'icon{s}.png')
    print('done')
