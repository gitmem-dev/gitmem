# OG Image Compositing with Terminal Screenshots

## Overview

Embed a mini terminal screenshot into a feature/OG image (1200x630) using Sharp.
The terminal frame sits on the right side with rounded corners and a subtle shadow.

## Full Recipe

```javascript
const sharp = require('sharp');

async function compositeTerminalOntoOG(gifPath, basePngPath, outputPath) {
  // 1. Extract best frame from GIF (usually the last)
  const meta = await sharp(gifPath, { animated: true, pages: -1 }).metadata();
  const lastPage = meta.pages - 1;
  const frame = await sharp(gifPath, { page: lastPage }).png().toBuffer();

  // 2. Crop to relevant content (skip Claude header if present)
  const frameMeta = await sharp(frame).metadata();
  const cropTop = 130;  // Skip Claude Code header (~130px)
  const cropHeight = frameMeta.height - cropTop - 20;
  const cropped = await sharp(frame)
    .extract({ left: 0, top: cropTop, width: frameMeta.width, height: cropHeight })
    .png()
    .toBuffer();

  // 3. Resize for OG image
  const termW = 460;
  const croppedMeta = await sharp(cropped).metadata();
  const termH = Math.round(termW * (croppedMeta.height / croppedMeta.width));
  const resized = await sharp(cropped).resize(termW, termH).png().toBuffer();

  // 4. Apply rounded corners
  const radius = 10;
  const mask = Buffer.from(
    `<svg width="${termW}" height="${termH}">
      <rect width="${termW}" height="${termH}" rx="${radius}" ry="${radius}" fill="white"/>
    </svg>`
  );
  const rounded = await sharp(resized)
    .composite([{ input: await sharp(mask).png().toBuffer(), blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 5. Create shadow frame
  const pad = 10;
  const frameW = termW + pad * 2;
  const frameH = termH + pad * 2;
  const frameSvg = Buffer.from(
    `<svg width="${frameW}" height="${frameH}">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000" flood-opacity="0.5"/>
        </filter>
      </defs>
      <rect x="${pad}" y="${pad}" width="${termW}" height="${termH}"
            rx="${radius+2}" ry="${radius+2}" fill="#333" filter="url(#shadow)"/>
    </svg>`
  );
  const frameImg = await sharp(frameSvg).png().toBuffer();

  // 6. Composite terminal onto shadow frame
  const framed = await sharp(frameImg)
    .composite([{ input: rounded, left: pad, top: pad }])
    .png()
    .toBuffer();

  // 7. Position on OG image (right side, vertically centered)
  const OG_W = 1200, OG_H = 630;
  const termLeft = OG_W - frameW - 40;
  const termTop = Math.round((OG_H - 60 - frameH) / 2) + 10;  // 60px = bottom bar

  // 8. Composite onto base OG image
  await sharp(basePngPath)
    .composite([{ input: framed, left: termLeft, top: termTop }])
    .png()
    .toFile(outputPath);
}
```

## Positioning Guide

### For 1200x630 OG Images

```
+--------------------------------------------------+
|  TAG                                              |
|  Title Text        [Terminal Screenshot]          |
|  (left 80px)       (right, ~460px wide)           |
|                                                   |
|  [Logo] GitMem                    gitmem.ai/blog  |
+--------------------------------------------------+
```

- **Terminal left edge**: `OG_WIDTH - frameWidth - 40`
- **Terminal top**: Vertically centered in available space (above bottom bar)
- **Bottom bar height**: 60px (reserved for branding)

### For Different Aspect Ratios

| Format | Dimensions | Terminal Width | Position |
|--------|-----------|---------------|----------|
| OG/Twitter | 1200x630 | 440-480px | Right, centered |
| Square | 1080x1080 | 500-600px | Bottom half |
| Blog inline | 600px max | Full width | Centered |

## Crop Regions

Common crop settings for different content:

| Content | cropTop | Notes |
|---------|---------|-------|
| Full ceremony (skip header) | 130 | Removes Claude logo + prompt |
| Just scars | 400+ | Shows only scar output |
| Just threads | 200 | Shows session start + threads |
| Everything | 0 | Full terminal including logo |

## Dependencies

```bash
npm install sharp  # Image processing
```

Sharp handles PNG/GIF/JPEG compositing. For animated GIF frame extraction,
use the `{ page: N }` option where N is 0-indexed frame number.
