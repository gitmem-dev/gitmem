# Claude Code Terminal Palette

## Theme JSON (for .cast header)

```json
{
  "fg": "#a1a1a1",
  "bg": "#30302d",
  "palette": "#000000:#DA7756:#00a600:#999900:#0000b3:#b300b3:#00a6b3:#bfbfbf:#262624:#e65535:#00d900:#e6e600:#0000ff:#e600e6:#00e6e6:#e6e6e6"
}
```

## 16-Color Palette Map

| Index | ANSI Code | Hex | Name | Usage |
|-------|-----------|-----|------|-------|
| 0 | `\x1b[30m` | `#000000` | Black | — |
| 1 | `\x1b[31m` | `#DA7756` | **Claude Orange** | Logo, accent |
| 2 | `\x1b[32m` | `#00a600` | Green | Success text |
| 3 | `\x1b[33m` | `#999900` | Yellow | Warnings |
| 4 | `\x1b[34m` | `#0000b3` | Blue | — |
| 5 | `\x1b[35m` | `#b300b3` | Magenta | — |
| 6 | `\x1b[36m` | `#00a6b3` | Cyan | Threads header |
| 7 | `\x1b[37m` | `#bfbfbf` | White | Body text |
| 8 | `\x1b[90m` | `#262624` | Bright Black | — |
| 9 | `\x1b[91m` | `#e65535` | **Bright Red** | HIGH severity |
| 10 | `\x1b[92m` | `#00d900` | Bright Green | Session start, ready |
| 11 | `\x1b[93m` | `#e6e600` | Bright Yellow | MED severity, decisions |
| 12 | `\x1b[94m` | `#0000ff` | Bright Blue | — |
| 13 | `\x1b[95m` | `#e600e6` | Bright Magenta | Bypass mode |
| 14 | `\x1b[96m` | `#00e6e6` | Bright Cyan | Threads header |
| 15 | `\x1b[97m` | `#e6e6e6` | Bright White | Prompt, agent output |

## ANSI Escape Code Quick Reference

```javascript
const ESC = '\x1b';
const RESET    = `${ESC}[0m`;
const BOLD     = `${ESC}[1m`;
const DIM      = `${ESC}[2m`;
const NORMAL   = `${ESC}[22m`;   // Reset bold/dim
const RED      = `${ESC}[31m`;   // Claude orange (#DA7756)
const GREEN    = `${ESC}[32m`;
const YELLOW   = `${ESC}[33m`;
const CYAN     = `${ESC}[36m`;
const WHITE    = `${ESC}[37m`;
const BG_BLK   = `${ESC}[40m`;  // Black background (for logo blocks)
const BG_DEF   = `${ESC}[49m`;  // Default background
const FG_DEF   = `${ESC}[39m`;  // Default foreground
const BR_RED   = `${ESC}[91m`;  // Bright red (#e65535)
const BR_GREEN = `${ESC}[92m`;  // Bright green (#00d900)
const BR_YELLOW= `${ESC}[93m`;  // Bright yellow (#e6e600)
const BR_CYAN  = `${ESC}[96m`;  // Bright cyan (#00e6e6)
const BR_WHITE = `${ESC}[97m`;  // Bright white (#e6e6e6)
const BR_MAG   = `${ESC}[95m`;  // Bright magenta (#e600e6)
```

## Claude Code Block-Art Logo

The Claude Code logo is rendered using Unicode block characters with ANSI color 1 (orange):

```
 ▐▛███▜▌   Claude Code v2.X.XX
▝▜█████▛▘  Sonnet 4.5 · API key
  ▘▘ ▝▝    ~/project-path
```

ANSI rendering:

```javascript
outln(0.0, ` ${RED}▐${BG_BLK}▛███▜${BG_DEF}▌${FG_DEF}   ${BOLD}Claude Code${NORMAL} ${WHITE}vX.X.XX${FG_DEF}`);
outln(0.0, `${RED}▝▜${BG_BLK}█████${BG_DEF}▛▘${FG_DEF}  ${WHITE}Sonnet 4.5 · API key${FG_DEF}`);
outln(0.0, `${RED}  ▘▘ ▝▝${FG_DEF}    ${WHITE}~/my-project${FG_DEF}`);
```

## Critical Color Notes

- **Palette index 1 is Claude's brand orange (`#DA7756`), NOT standard terminal red.** This is the most common mistake — standard xterm palette uses `#990000` for index 1, which renders the logo as dark red instead of the correct terracotta/orange.
- **Bright red (index 9, `#e65535`)** is used for HIGH severity scar indicators, not for the logo.
- **Background `#30302d`** is a warm dark gray, not pure black. This matches the actual Claude Code terminal.
