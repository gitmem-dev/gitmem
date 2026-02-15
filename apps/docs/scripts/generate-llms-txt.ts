#!/usr/bin/env tsx
/**
 * Generate llms.txt and llms-full.txt from MDX content
 *
 * - public/llms.txt: Structured index with titles + paths
 * - public/llms-full.txt: Full content concatenation for LLM consumption
 *
 * Run: npm run generate:llms (from apps/docs/)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_DIR = join(__dirname, "../content/docs");
const PUBLIC_DIR = join(__dirname, "../public");
const BASE_URL = "https://docs.gitmem.ai";

interface Page {
  path: string;
  title: string;
  description: string;
  content: string;
}

function extractFrontmatter(raw: string): {
  title: string;
  description: string;
  body: string;
} {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { title: "", description: "", body: raw };

  const fm = match[1];
  const body = match[2].trim();

  const titleMatch = fm.match(/title:\s*"?([^"\n]+)"?/);
  const descMatch = fm.match(/description:\s*"?([^"\n]+)"?/);

  return {
    title: titleMatch?.[1]?.trim() || "",
    description: descMatch?.[1]?.trim() || "",
    body,
  };
}

function mdxToUrl(filePath: string): string {
  let rel = relative(CONTENT_DIR, filePath);
  // Remove .mdx extension
  rel = rel.replace(/\.mdx$/, "");
  // index pages map to directory
  rel = rel.replace(/\/index$/, "");
  if (rel === "index") rel = "";
  return `${BASE_URL}/docs${rel ? "/" + rel : ""}`;
}

// ============================================================================
// Collect all MDX files
// ============================================================================

// Use a simple recursive glob approach
function findMdxFiles(dir: string): string[] {
  const { readdirSync, statSync } = require("node:fs");
  const results: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findMdxFiles(full));
    } else if (entry.endsWith(".mdx")) {
      results.push(full);
    }
  }

  return results.sort();
}

const mdxFiles = findMdxFiles(CONTENT_DIR);
const pages: Page[] = [];

for (const file of mdxFiles) {
  const raw = readFileSync(file, "utf-8");
  const { title, description, body } = extractFrontmatter(raw);
  const url = mdxToUrl(file);

  pages.push({
    path: url,
    title: title || relative(CONTENT_DIR, file),
    description,
    content: body,
  });
}

// ============================================================================
// Generate llms.txt (index)
// ============================================================================

mkdirSync(PUBLIC_DIR, { recursive: true });

let index = `# GitMem Documentation

> GitMem is institutional memory for AI agents — scars, sessions, threads, and learnings that persist across conversations.

## Pages

`;

for (const page of pages) {
  index += `- [${page.title}](${page.path})`;
  if (page.description) {
    index += `: ${page.description}`;
  }
  index += "\n";
}

writeFileSync(join(PUBLIC_DIR, "llms.txt"), index);
console.error(`Generated llms.txt (${pages.length} pages indexed)`);

// ============================================================================
// Generate llms-full.txt (full content)
// ============================================================================

let full = `# GitMem Documentation (Full)

> Complete documentation for GitMem — institutional memory for AI agents.
> Source: ${BASE_URL}

`;

for (const page of pages) {
  full += `${"=".repeat(72)}\n`;
  full += `# ${page.title}\n`;
  full += `URL: ${page.path}\n`;
  if (page.description) {
    full += `Description: ${page.description}\n`;
  }
  full += `${"=".repeat(72)}\n\n`;
  full += page.content + "\n\n";
}

writeFileSync(join(PUBLIC_DIR, "llms-full.txt"), full);
console.error(`Generated llms-full.txt (${pages.length} pages, ${Math.round(full.length / 1024)}KB)`);
