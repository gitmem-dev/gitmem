#!/usr/bin/env tsx
/**
 * Generate tool reference MDX pages from definitions.ts
 *
 * Reads the TOOLS array and tier gating sets from the GitMem source,
 * then generates one MDX file per canonical tool in content/docs/tools/.
 *
 * Run: npm run generate:tools (from apps/docs/)
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOOLS,
  CACHE_TOOL_NAMES,
  BATCH_TOOL_NAMES,
  TRANSCRIPT_TOOL_NAMES,
  ANALYZE_TOOL_NAMES,
  GRAPH_TOOL_NAMES,
  ARCHIVE_TOOL_NAMES,
} from "../../../src/tools/definitions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, "../content/docs/tools");

// ============================================================================
// Types
// ============================================================================

interface PropertySchema {
  type?: string;
  description?: string;
  enum?: string[];
  items?: PropertySchema & { properties?: Record<string, PropertySchema>; required?: string[] };
  properties?: Record<string, PropertySchema>;
  required?: string[];
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, PropertySchema>;
    required?: string[];
  };
}

// ============================================================================
// Canonical tool identification
// ============================================================================

// Tools without gitmem-/gm- prefix are canonical, plus these special cases:
const SPECIAL_CANONICAL = new Set([
  "gitmem-help",
  "gitmem-cache-status",
  "gitmem-cache-health",
  "gitmem-cache-flush",
]);

// Virtual names used in gm-cache-* alias descriptions
const VIRTUAL_TO_CANONICAL: Record<string, string> = {
  cache_status: "gitmem-cache-status",
  cache_health: "gitmem-cache-health",
  cache_flush: "gitmem-cache-flush",
};

function isCanonical(tool: ToolDef): boolean {
  if (SPECIAL_CANONICAL.has(tool.name)) return true;
  return !tool.name.startsWith("gitmem-") && !tool.name.startsWith("gm-");
}

function getCanonicalRef(tool: ToolDef): string | null {
  // Alias descriptions follow: "alias-name (canonical_name) - description"
  const match = tool.description.match(/^\S+\s+\((\w+)\)\s*[-–—]/);
  if (!match) return null;
  const ref = match[1];
  return VIRTUAL_TO_CANONICAL[ref] || ref;
}

function getTier(toolName: string): "free" | "pro" | "dev" {
  if (BATCH_TOOL_NAMES.has(toolName)) return "dev";
  if (TRANSCRIPT_TOOL_NAMES.has(toolName)) return "dev";
  if (CACHE_TOOL_NAMES.has(toolName)) return "pro";
  if (ANALYZE_TOOL_NAMES.has(toolName)) return "pro";
  if (GRAPH_TOOL_NAMES.has(toolName)) return "pro";
  if (ARCHIVE_TOOL_NAMES.has(toolName)) return "pro";
  return "free";
}

function toSlug(name: string): string {
  return name.replace(/^gitmem-/, "").replace(/_/g, "-");
}

function escapeMarkdown(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function cleanDescription(desc: string): string {
  return desc
    .replace(/\s*OD-\d+:[^.]+\./g, "")
    .replace(/\s*DISPLAY:[^.]+\./g, "")
    .trim();
}

function formatType(schema: PropertySchema): string {
  if (schema.enum) {
    return schema.enum.map((v) => `\`"${v}"\``).join(" \\| ");
  }
  if (schema.type === "array" && schema.items) {
    const itemType = schema.items.type || "object";
    return `${itemType}[]`;
  }
  return schema.type || "any";
}

// ============================================================================
// Build canonical → aliases mapping
// ============================================================================

const tools = TOOLS as ToolDef[];
const canonicalTools = tools.filter(isCanonical);
const aliasMap: Record<string, string[]> = {};

for (const tool of canonicalTools) {
  aliasMap[tool.name] = [];
}

for (const tool of tools) {
  if (isCanonical(tool)) continue;
  const ref = getCanonicalRef(tool);
  if (ref && aliasMap[ref] !== undefined) {
    aliasMap[ref].push(tool.name);
  }
}

// ============================================================================
// Generate MDX files
// ============================================================================

mkdirSync(TOOLS_DIR, { recursive: true });

let generated = 0;

for (const tool of canonicalTools) {
  const slug = toSlug(tool.name);
  const tier = getTier(tool.name);
  const aliases = aliasMap[tool.name] || [];
  const description = cleanDescription(tool.description);
  const properties = tool.inputSchema.properties || {};
  const required = new Set(tool.inputSchema.required || []);

  const metaDesc = description.split(/\.\s/)[0].replace(/\.$/, "") + ".";

  let mdx = `---
title: "${tool.name}"
description: "${metaDesc.replace(/"/g, '\\"')}"
---

# ${tool.name}

`;

  // Tier + aliases badge line
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);
  const parts = [`**Tier:** ${tierLabel}`];
  if (aliases.length > 0) {
    parts.push(
      `**Aliases:** ${aliases.map((a) => `\`${a}\``).join(", ")}`
    );
  }
  mdx += parts.join(" · ") + "\n\n";

  // Full description
  mdx += description + "\n\n";

  // Parameters table (top-level)
  const paramEntries = Object.entries(properties);
  if (paramEntries.length > 0) {
    mdx += "## Parameters\n\n";
    mdx += "| Parameter | Type | Required | Description |\n";
    mdx += "|-----------|------|----------|-------------|\n";

    for (const [name, schema] of paramEntries) {
      const isReq = required.has(name);
      const type = formatType(schema);
      const desc = escapeMarkdown(schema.description || "");
      mdx += `| \`${name}\` | ${type} | ${isReq ? "Yes" : "No"} | ${desc} |\n`;
    }
    mdx += "\n";

    // Nested object schemas (for array-of-objects params like confirmations, observations)
    for (const [name, schema] of paramEntries) {
      if (
        schema.type === "array" &&
        schema.items?.type === "object" &&
        schema.items.properties
      ) {
        const nested = schema.items.properties;
        const nestedReq = new Set(schema.items.required || []);

        mdx += `### ${name} items\n\n`;
        mdx += "| Field | Type | Required | Description |\n";
        mdx += "|-------|------|----------|-------------|\n";

        for (const [field, fieldSchema] of Object.entries(nested)) {
          const type = formatType(fieldSchema as PropertySchema);
          const desc = escapeMarkdown(
            (fieldSchema as PropertySchema).description || ""
          );
          mdx += `| \`${field}\` | ${type} | ${nestedReq.has(field) ? "Yes" : "No"} | ${desc} |\n`;
        }
        mdx += "\n";
      }
    }
  }

  const filePath = join(TOOLS_DIR, `${slug}.mdx`);
  writeFileSync(filePath, mdx);
  generated++;
  console.error(`  ${slug}.mdx (${tool.name}, ${tier})`);
}

// ============================================================================
// Update meta.json
// ============================================================================

const slugs = canonicalTools.map((t) => toSlug(t.name)).sort();
const meta = {
  title: "Tools",
  pages: ["index", ...slugs],
};
writeFileSync(join(TOOLS_DIR, "meta.json"), JSON.stringify(meta, null, 2) + "\n");

console.error(`\nGenerated ${generated} tool reference pages`);
console.error(`Updated tools/meta.json with ${slugs.length} entries`);
