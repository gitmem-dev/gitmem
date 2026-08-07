#!/usr/bin/env tsx
/**
 * Generate the docs changelog page from the root CHANGELOG.md
 *
 * The root CHANGELOG.md is the single source of truth — it is updated as part of
 * every release. This script derives content/docs/changelog.mdx from it so the
 * published changelog can never drift from the released one.
 *
 * Transforms applied:
 * - Drops the Keep a Changelog preamble (everything before the first version)
 * - Drops the [Unreleased] section (not yet shipped, so not public history)
 * - Rewrites `## [1.7.0] - 2026-08-07` headings to `## v1.7.0 (2026-08-07)`
 * - Strips trailing link-reference definitions (`[1.0.0]: https://...`)
 * - Escapes MDX-hazardous characters outside code spans and fences
 *
 * Run: npm run generate:changelog (from apps/docs/)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "../../../CHANGELOG.md");
const OUTPUT_PATH = join(__dirname, "../content/docs/changelog.mdx");

const FRONTMATTER = `---
title: Changelog
description: GitMem release history.
---`;

const GENERATED_NOTICE =
  "{/* GENERATED FILE — do not edit. Source: CHANGELOG.md at the repo root. */}\n" +
  "{/* Regenerate with: npm run generate:changelog (from apps/docs/) */}";

/** `## [1.7.0] - 2026-08-07` (the date is optional in older entries) */
const VERSION_HEADING = /^##\s+\[([^\]]+)\](?:\s+-\s+(\S+))?\s*$/;
/** `[1.0.0]: https://github.com/...` */
const LINK_DEFINITION = /^\[[^\]]+\]:\s+\S+\s*$/;

/**
 * MDX parses `{` as an expression and `<` as JSX, so a changelog entry containing
 * either outside of code would fail the docs build. Escape them, but leave fenced
 * blocks and inline code spans untouched — they are already inert in MDX.
 */
function escapeForMdx(body: string): string {
  const lines = body.split("\n");
  let inFence = false;

  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;

      // Split on inline code spans so only the prose between them is escaped.
      return line
        .split(/(`[^`]*`)/g)
        .map((segment) =>
          segment.startsWith("`") && segment.endsWith("`") && segment.length > 1
            ? segment
            : segment.replace(/[{}<]/g, (char) => `\\${char}`)
        )
        .join("");
    })
    .join("\n");
}

function generate(): void {
  const raw = readFileSync(CHANGELOG_PATH, "utf8");
  const lines = raw.split("\n");

  const out: string[] = [];
  let started = false;
  let skippingUnreleased = false;
  let versionCount = 0;

  for (const line of lines) {
    const heading = line.match(VERSION_HEADING);

    if (heading) {
      const [, version, date] = heading;

      if (version.toLowerCase() === "unreleased") {
        skippingUnreleased = true;
        continue;
      }

      started = true;
      skippingUnreleased = false;
      versionCount += 1;
      out.push(date ? `## v${version} (${date})` : `## v${version}`);
      continue;
    }

    // Everything before the first version heading is Keep a Changelog boilerplate.
    if (!started || skippingUnreleased) continue;
    if (LINK_DEFINITION.test(line)) continue;

    out.push(line);
  }

  if (versionCount === 0) {
    throw new Error(
      `No version headings found in ${CHANGELOG_PATH}. Expected entries like "## [1.7.0] - 2026-08-07".`
    );
  }

  const body = escapeForMdx(out.join("\n").trim());
  const contents = `${FRONTMATTER}\n\n${GENERATED_NOTICE}\n\n# Changelog\n\n${body}\n`;

  writeFileSync(OUTPUT_PATH, contents, "utf8");
  console.log(`✅ changelog.mdx generated — ${versionCount} versions from CHANGELOG.md`);
}

generate();
