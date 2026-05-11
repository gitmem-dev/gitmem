/**
 * index_docs Tool
 *
 * Scans a directory of markdown files, chunks them, embeds them,
 * and stores them in the doc index for semantic search.
 *
 * Supports incremental indexing: only re-processes changed files.
 */

import * as fs from "fs";
import * as path from "path";
import { chunkDirectory, scanDirectory, chunkDocument } from "../services/doc-chunker.js";
import {
  indexChunks,
  getChangedFiles,
  getIndexStats,
  clearDocIndex,
} from "../services/doc-index.js";
import { getProject } from "../services/session-state.js";
import { wrapDisplay, productLine, dimText } from "../services/display-protocol.js";
import type { Project } from "../types/index.js";

export interface IndexDocsParams {
  directory: string;
  project?: Project;
  exclude?: string[];
  force?: boolean;
  clear?: boolean;
}

export interface IndexDocsResult {
  directory: string;
  project: string;
  files_scanned: number;
  files_changed: number;
  files_unchanged: number;
  chunks_indexed: number;
  chunks_embedded: number;
  errors: number;
  categories: Record<string, number>;
  display: string;
}

export async function indexDocs(params: IndexDocsParams): Promise<IndexDocsResult> {
  const directory = params.directory;
  const project: string = params.project || (getProject() as string) || "default";
  const exclude = params.exclude || ["_archive", "node_modules", ".git"];
  const force = params.force || false;

  // Validate directory exists
  if (!fs.existsSync(directory)) {
    const display = wrapDisplay(
      [
        productLine("index_docs", "error"),
        "",
        `Directory not found: ${directory}`,
        "",
        "Provide an absolute path to a directory containing .md files.",
      ].join("\n")
    );
    return {
      directory,
      project,
      files_scanned: 0,
      files_changed: 0,
      files_unchanged: 0,
      chunks_indexed: 0,
      chunks_embedded: 0,
      errors: 1,
      categories: {},
      display,
    };
  }

  // Handle clear request
  if (params.clear) {
    const removed = clearDocIndex(project);
    const display = wrapDisplay(
      [
        productLine("index_docs", `cleared ${removed} chunks for project="${project}"`),
      ].join("\n")
    );
    return {
      directory,
      project,
      files_scanned: 0,
      files_changed: 0,
      files_unchanged: 0,
      chunks_indexed: 0,
      chunks_embedded: 0,
      errors: 0,
      categories: {},
      display,
    };
  }

  // Scan directory for .md files
  const files = scanDirectory(directory, { exclude });

  if (files.length === 0) {
    const display = wrapDisplay(
      [
        productLine("index_docs", "no markdown files found"),
        "",
        `Scanned: ${directory}`,
        `Excluded: ${exclude.join(", ")}`,
      ].join("\n")
    );
    return {
      directory,
      project,
      files_scanned: 0,
      files_changed: 0,
      files_unchanged: 0,
      chunks_indexed: 0,
      chunks_embedded: 0,
      errors: 0,
      categories: {},
      display,
    };
  }

  // Incremental indexing: check which files changed
  const fileHashes = new Map(
    files.map((f) => [f.relative_path, f.hash])
  );

  let filesToProcess = files;
  let filesUnchanged = 0;

  if (!force) {
    const changes = getChangedFiles(fileHashes, project);
    const changedSet = new Set([...changes.changed, ...changes.new_files]);

    if (changedSet.size === 0) {
      const stats = getIndexStats(project);
      const display = wrapDisplay(
        [
          productLine("index_docs", "up to date — no changes detected"),
          "",
          `${files.length} files scanned, all unchanged`,
          `${stats.total_chunks} chunks in index`,
          "",
          dimText("Use force=true to re-index all files"),
        ].join("\n")
      );
      return {
        directory,
        project,
        files_scanned: files.length,
        files_changed: 0,
        files_unchanged: files.length,
        chunks_indexed: 0,
        chunks_embedded: 0,
        errors: 0,
        categories: stats.categories,
        display,
      };
    }

    filesToProcess = files.filter((f) => changedSet.has(f.relative_path));
    filesUnchanged = files.length - filesToProcess.length;
  }

  // Chunk the changed files
  const allChunks = [];
  for (const file of filesToProcess) {
    allChunks.push(...chunkDocument(file));
  }

  // Index chunks (embed + store)
  const result = await indexChunks(allChunks, project);

  // Get updated stats
  const stats = getIndexStats(project);

  // Build display
  const lines: string[] = [];
  lines.push(
    productLine(
      "index_docs",
      `${filesToProcess.length} files → ${result.indexed} chunks`
    )
  );
  lines.push("");
  lines.push(`Directory: ${directory}`);
  lines.push(`Project: ${project}`);
  lines.push("");
  lines.push(`Files scanned:   ${files.length}`);
  lines.push(`Files changed:   ${filesToProcess.length}`);
  lines.push(`Files unchanged: ${filesUnchanged}`);
  lines.push(`Chunks indexed:  ${result.indexed}`);
  lines.push(`Chunks embedded: ${result.embedded}`);
  if (result.errors > 0) {
    lines.push(`Errors:          ${result.errors}`);
  }
  lines.push("");

  // Category breakdown
  if (Object.keys(stats.categories).length > 0) {
    lines.push("Categories:");
    for (const [cat, count] of Object.entries(stats.categories).sort(
      (a, b) => b[1] - a[1]
    )) {
      lines.push(`  ${cat.padEnd(20)} ${count} chunks`);
    }
    lines.push("");
  }

  lines.push(`Total index: ${stats.total_chunks} chunks across ${stats.total_files} files`);

  const display = wrapDisplay(lines.join("\n"));

  return {
    directory,
    project,
    files_scanned: files.length,
    files_changed: filesToProcess.length,
    files_unchanged: filesUnchanged,
    chunks_indexed: result.indexed,
    chunks_embedded: result.embedded,
    errors: result.errors,
    categories: stats.categories,
    display,
  };
}
