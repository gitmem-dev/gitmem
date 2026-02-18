---
name: Terminal GIF
description: >
  This skill should be used when the user asks to "create a terminal GIF",
  "record a terminal animation", "make a terminal screenshot for the blog",
  "generate a cast file", "create an asciinema recording", "animate a CLI demo",
  or needs animated terminal visuals for blog posts, documentation, or social media.
  Covers the full pipeline: synthetic cast file authoring, GIF rendering with agg,
  and optional OG image compositing with Sharp.
---

# Terminal GIF — Animated Terminal Recordings for Content

Generate animated terminal GIFs from synthetic asciinema v3 cast files. The
pipeline produces pixel-perfect terminal animations without requiring screen
recording — content is authored programmatically with full control over timing,
colors, and text.

## When to Use

- Blog posts that need a terminal demo (session start, CLI output, etc.)
- OG/feature images that embed a mini terminal screenshot
- Documentation showing CLI workflows
- Social media content with terminal visuals

## Pipeline Overview

```
1. Author content  →  Node.js script generates .cast file (ANSI escape sequences)
2. Render GIF      →  agg binary converts .cast → .gif with terminal fonts
3. (Optional)      →  Sharp composites GIF frame onto OG image
```

## Step 1: Create the Cast Generator Script

Create a Node.js script that builds an asciinema v3 cast file. The cast format
is JSONL — a JSON header line followed by event lines: `[delta_seconds, "o", "data"]`.

### Cast File Structure

```jsonl
{"version":3,"term":{"cols":80,"rows":36,"type":"xterm","theme":{...}},"timestamp":1234567890}
[0.5,"o","$ "]
[0.1,"o","c"]
[0.08,"o","l"]
```

- **Header**: version, terminal dimensions, color theme
- **Events**: `[delay_from_previous, "o", "output_text"]`
- **ANSI escapes**: Use standard escape sequences for color/formatting

### Claude Code Color Palette (CRITICAL)

Use the exact Claude Code terminal theme. See `references/claude-code-palette.md` for
the full 16-color palette and ANSI escape code mapping.

Key colors:
- **Background**: `#30302d` (warm dark gray)
- **Foreground**: `#a1a1a1` (medium gray)
- **Claude logo**: Palette index 1 = `#DA7756` (orange/terracotta, NOT red)
- **Bright red** (scar HIGH): Palette index 9 = `#e65535`

### Timing Guidelines

| Element | Delay | Notes |
|---------|-------|-------|
| Typing each character | 0.06-0.14s | Randomize for natural feel |
| Enter key | 0.3-0.4s | Slight pause before submit |
| Section transitions | 0.6-1.2s | Simulates processing |
| Final hold | 2-3s | Let viewer read the result |

### Working Example

See `examples/generate-ceremony-cast.mjs` for a complete cast generator that produces
the GitMem session start ceremony animation. Key patterns:

- `out(delay, text)` / `outln(delay, text)` helper functions
- Character-by-character typing with randomized delays
- Multi-color ANSI sequences for styled output
- Claude Code block-art logo rendering

## Step 2: Render with agg

[agg](https://github.com/asciinema/agg) is the asciinema GIF generator. It renders
`.cast` files to `.gif` with proper terminal fonts and anti-aliasing.

### Install agg

```bash
# Download pre-built binary (no compiler needed)
# Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ]; then
  AGG_BIN="agg-aarch64-unknown-linux-gnu"
elif [ "$ARCH" = "x86_64" ]; then
  AGG_BIN="agg-x86_64-unknown-linux-gnu"
fi

curl -L "https://github.com/asciinema/agg/releases/download/v1.7.0/${AGG_BIN}" -o /tmp/agg
chmod +x /tmp/agg
```

### Render Command

```bash
/tmp/agg input.cast output.gif --speed 1 --font-size 14 --line-height 1.4
```

Options:
- `--speed 1`: Real-time playback (increase to speed up)
- `--font-size 14`: Good for blog embeds (12-16 range)
- `--line-height 1.4`: Comfortable reading spacing
- `--cols 80 --rows 36`: Override terminal dimensions

### Verify Output

The GIF will typically be 100-200KB for a 10-15 second animation. Check the
last frame visually — the Read tool only shows the first frame of animated GIFs.
Extract the last frame with Sharp to verify:

```javascript
await sharp('output.gif', { page: -1 }).png().toFile('/tmp/last-frame.png');
```

## Step 3: Composite into OG Image (Optional)

To embed a mini terminal screenshot in a feature/OG image:

1. Extract the best frame from the GIF (usually the last)
2. Crop to the relevant content area
3. Resize to fit (~400-500px wide)
4. Apply rounded corners
5. Composite onto the base OG image with Sharp

See `references/og-compositing.md` for the Sharp compositing recipe.

### Key Dimensions

| Context | Terminal Width | Position |
|---------|--------------|----------|
| OG image (1200x630) | 440-480px | Right side, vertically centered |
| Blog embed | 600px max | Centered, `.terminal-frame` CSS class |
| X/Twitter card | 400px | Right side |

## Blog Integration

### CSS for Terminal Frames

Add to the blog build if not already present:

```css
.terminal-frame {
  margin: 32px auto;
  max-width: 600px;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid var(--color-primary);
  box-shadow: 0 8px 32px rgba(0,0,0,0.15);
}
.terminal-frame img { width: 100%; height: auto; display: block; }
```

### Markdown Embed

```html
<div class="terminal-frame">
  <img src="/blog/images/my-animation.gif" alt="Description" loading="lazy" />
</div>
```

### MIME Type

Ensure the serving layer handles `.gif`:

```javascript
'.gif': 'image/gif'  // Add to mime type map
```

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Logo renders red, not orange | Wrong palette index 1 | Set to `#DA7756` |
| GIF clipped at bottom | Terminal rows too small | Increase `rows` in header |
| Block characters garbled | Wrong font in renderer | Use agg (has built-in fonts) |
| Read tool shows blank frame | Shows frame 1, which may be empty | Extract last frame with Sharp |
| SVG rendering looks bad | Unicode blocks render poorly in SVG | Use agg — do not attempt SVG-based rendering |

## Additional Resources

### Reference Files

- **`references/claude-code-palette.md`** — Full 16-color palette, ANSI codes, theme JSON
- **`references/og-compositing.md`** — Sharp recipe for OG image compositing

### Examples

- **`examples/generate-ceremony-cast.mjs`** — Complete session start ceremony generator

### Scripts

- **`scripts/install-agg.sh`** — Download and install the agg binary
