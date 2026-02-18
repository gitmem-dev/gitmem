#!/usr/bin/env node
/**
 * Generate a synthetic .cast (asciinema v3) file showing a GitMem session start.
 * Content is anonymized. Then render it to GIF with `agg`.
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ANSI escape helpers
const ESC = '\x1b';
const RESET    = `${ESC}[0m`;
const BOLD     = `${ESC}[1m`;
const DIM      = `${ESC}[2m`;
const NORMAL   = `${ESC}[22m`;
const RED      = `${ESC}[31m`;     // palette 1: #DA7756 (Claude orange)
const GREEN    = `${ESC}[32m`;     // palette 2: #00a600
const YELLOW   = `${ESC}[33m`;     // palette 3: #999900
const CYAN     = `${ESC}[36m`;     // palette 6: #00a6b3
const WHITE    = `${ESC}[37m`;     // palette 7: #bfbfbf
const BG_BLK   = `${ESC}[40m`;    // black bg (for logo blocks)
const BG_DEF   = `${ESC}[49m`;    // default bg
const FG_DEF   = `${ESC}[39m`;    // default fg
const BR_RED   = `${ESC}[91m`;    // bright red: #e65535
const BR_GREEN = `${ESC}[92m`;    // bright green: #00d900
const BR_YELLOW= `${ESC}[93m`;    // bright yellow: #e6e600
const BR_CYAN  = `${ESC}[96m`;    // bright cyan: #00e6e6
const BR_WHITE = `${ESC}[97m`;    // bright white: #e6e6e6
const BR_MAG   = `${ESC}[95m`;    // bright magenta: #e600e6

// Build the cast file events: [delta_seconds, "o", "data"]
const events = [];
let t = 0;

function out(delay, text) {
  events.push([delay, 'o', text]);
  t += delay;
}

function outln(delay, text) {
  out(delay, text + '\r\n');
}

// --- Scene 1: Shell prompt + type "claude" ---
out(0.5, '$ ');
// Type "claude" character by character
for (const ch of 'claude') {
  out(0.08 + Math.random() * 0.06, ch);
}
out(0.3, '\r\n');

// --- Scene 2: Claude Code header (actual layout from recordings) ---
out(1.2, '');

// Line 1: logo + Claude Code
outln(0.0, ` ${RED}▐${BG_BLK}▛███▜${BG_DEF}▌${FG_DEF}   ${BOLD}Claude Code${NORMAL} ${WHITE}v2.1.32${FG_DEF}`);

// Line 2: logo + model
outln(0.0, `${RED}▝▜${BG_BLK}█████${BG_DEF}▛▘${FG_DEF}  ${WHITE}Sonnet 4.5 · API key${FG_DEF}`);

// Line 3: logo feet + path
outln(0.0, `${RED}  ▘▘ ▝▝${FG_DEF}    ${WHITE}~/my-project${FG_DEF}`);

outln(0.0, '');

// Horizontal rule
outln(0.0, `${DIM}${WHITE}${'─'.repeat(76)}${FG_DEF}${NORMAL}`);

// Prompt hint
outln(0.0, `${DIM}❯ ${NORMAL}Try "how does <filepath> work?"${RESET}`);

// Horizontal rule
outln(0.0, `${DIM}${WHITE}${'─'.repeat(76)}${FG_DEF}${NORMAL}`);

// Status bar
outln(0.0, `  ${BR_MAG}⏵⏵ bypass permissions on${FG_DEF}`);

// --- Scene 3: User types "lets start" ---
out(1.5, '');

// Replace prompt area
outln(0.0, '');
out(0.0, `${BR_WHITE}❯ ${RESET}`);
for (const ch of 'lets start') {
  out(0.06 + Math.random() * 0.05, `${BR_WHITE}${ch}${RESET}`);
}
out(0.4, '\r\n');

// --- Scene 4: Frosting spinner ---
outln(0.3, `${RED}· Frosting…${FG_DEF}`);
outln(0.8, `  ${BR_YELLOW}SessionStart hook firing...${FG_DEF}`);

// --- Scene 5: GitMem session start ---
out(1.0, '\r\n');
outln(0.0, `  ${BR_GREEN}${BOLD}gitmem ── session started${NORMAL}${FG_DEF}`);
outln(0.1, `  ${DIM}a3f8b291 · cli · my-project${NORMAL}`);
outln(0.1, '');

// --- Scene 6: Threads ---
out(0.8, '');
outln(0.0, `  ${BR_CYAN}${BOLD}Threads (5)${NORMAL}${FG_DEF}`);
outln(0.15, `    Fix auth token refresh — stale JWT after 24h`);
outln(0.1, `    Migrate user table to use UUID primary keys`);
outln(0.1, `    Add rate limiting to /api/search endpoint`);
outln(0.1, `    Investigate Docker build cache misses on CI`);
outln(0.1, `    ${DIM}+1 more${NORMAL}`);
outln(0.0, '');

// --- Scene 7: Decisions ---
out(0.8, '');
outln(0.0, `  ${BR_YELLOW}${BOLD}Decisions (3)${NORMAL}${FG_DEF}`);
outln(0.15, `    Use Zod for API validation, not Joi    ${DIM}· Feb 18${NORMAL}`);
outln(0.1, `    Keep Postgres — no migration to Mongo  ${DIM}· Feb 17${NORMAL}`);
outln(0.1, `    Rate limit: token bucket, not sliding  ${DIM}· Feb 16${NORMAL}`);
outln(0.0, '');

// --- Scene 8: Summary ---
out(0.6, '');
outln(0.0, `  ${DIM}${'─'.repeat(50)}${NORMAL}`);
outln(0.2, `  ${BR_GREEN}3 scars recalled · 5 threads open · ready${FG_DEF}`);
outln(0.0, '');

// --- Scene 9: Agent response with scars ---
out(1.2, '');
outln(0.0, `  ${BR_WHITE}Loaded institutional memory. 3 scars surfaced:${FG_DEF}`);
outln(0.3, `    [${BR_RED}HIGH${FG_DEF}] JWT refresh tokens expire silently after rotation`);
outln(0.2, `    [${BR_YELLOW}MED${FG_DEF}]  Docker layer caching requires consistent COPY order`);
outln(0.2, `    [${DIM}LOW${NORMAL}]  Rate limit headers must include X-RateLimit-Reset`);
outln(0.0, '');
outln(0.5, `  ${BR_GREEN}Acknowledging scars before proceeding...${FG_DEF}`);

// Hold at end
out(3.0, '');

// --- Write .cast file ---
const header = {
  version: 3,
  term: {
    cols: 80,
    rows: 36,
    type: 'xterm',
    theme: {
      fg: '#a1a1a1',
      bg: '#30302d',
      palette: '#000000:#DA7756:#00a600:#999900:#0000b3:#b300b3:#00a6b3:#bfbfbf:#262624:#e65535:#00d900:#e6e600:#0000ff:#e600e6:#00e6e6:#e6e6e6'
    }
  },
  timestamp: Math.floor(Date.now() / 1000),
  idle_time_limit: 5.0,
};

const castPath = join(__dirname, 'images', 'session-start-ceremony.cast');
const gifPath = join(__dirname, 'images', 'session-start-ceremony.gif');

let castContent = JSON.stringify(header) + '\n';
for (const [delay, type, data] of events) {
  castContent += JSON.stringify([delay, type, data]) + '\n';
}

writeFileSync(castPath, castContent);
console.log(`Cast file: ${castPath} (${events.length} events, ${Math.round(t)}s total)`);

// --- Render with agg ---
try {
  execSync(`/tmp/agg ${castPath} ${gifPath} --speed 1 --font-size 14 --line-height 1.4`, {
    stdio: 'inherit',
  });
  console.log(`GIF: ${gifPath}`);
} catch (e) {
  console.error('agg render failed:', e.message);
  console.log('Cast file written — render manually with: agg', castPath, gifPath);
}
