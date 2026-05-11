/**
 * search_docs Tool
 *
 * Semantic search over indexed repository documentation.
 * Returns relevant chunks with file paths for targeted reading.
 *
 * Like search (for scars), but for docs.
 */

import { searchDocs as doSearch, getIndexStats } from "../services/doc-index.js";
import { getProject } from "../services/session-state.js";
import { wrapDisplay, productLine, dimText, truncate } from "../services/display-protocol.js";
import type { Project } from "../types/index.js";

export interface SearchDocsParams {
  query: string;
  project?: Project;
  category?: string;
  match_count?: number;
}

export interface SearchDocsResultEntry {
  id: string;
  file_path: string;
  chunk_index: number;
  title: string;
  section_title: string;
  category: string;
  content: string;
  similarity: number;
}

export interface SearchDocsResult {
  query: string;
  project: string;
  results: SearchDocsResultEntry[];
  total_found: number;
  index_stats: {
    total_chunks: number;
    total_files: number;
  };
  display: string;
}

export async function searchDocsHandler(
  params: SearchDocsParams
): Promise<SearchDocsResult> {
  const query = params.query;
  const project: string =
    params.project || (getProject() as string) || "default";
  const category = params.category;
  const matchCount = params.match_count || 5;

  // Check if index exists
  const stats = getIndexStats(project);

  if (stats.total_chunks === 0) {
    const display = wrapDisplay(
      [
        productLine("search_docs", "no docs indexed"),
        "",
        `No documents indexed for project="${project}".`,
        "",
        "Index docs first:",
        '  index_docs({ directory: "/path/to/docs", project: "my-project" })',
      ].join("\n")
    );
    return {
      query,
      project,
      results: [],
      total_found: 0,
      index_stats: {
        total_chunks: stats.total_chunks,
        total_files: stats.total_files,
      },
      display,
    };
  }

  // Search
  const results = await doSearch(query, {
    project,
    category,
    match_count: matchCount,
  });

  // Build display
  const lines: string[] = [];
  lines.push(
    productLine(
      "search_docs",
      `${results.length} results · "${truncate(query, 60)}"`
    )
  );

  if (category) {
    lines.push(`Category filter: ${category}`);
  }
  lines.push("");

  if (results.length === 0) {
    lines.push("No matching docs found.");
    lines.push("");
    lines.push(`Index contains ${stats.total_chunks} chunks across ${stats.total_files} files.`);
    lines.push("Available categories: " + Object.keys(stats.categories).join(", "));
  } else {
    // Show results with file paths prominently
    for (const r of results) {
      const sim = `(${r.similarity.toFixed(2)})`;
      const conf = r.similarity < 0.55 ? ` ${dimText("[low confidence]")}` : "";
      const section = r.section_title ? ` > ${r.section_title}` : "";

      lines.push(`${r.file_path}${section} ${sim}${conf}`);
      lines.push(`  ${truncate(r.title, 60)} [${r.category}]`);
      lines.push(`  ${truncate(r.content, 120)}`);
      lines.push("");
    }

    lines.push(
      dimText(
        `Searched ${stats.total_chunks} chunks across ${stats.total_files} files`
      )
    );
  }

  const display = wrapDisplay(lines.join("\n"));

  return {
    query,
    project,
    results: results.map((r) => ({
      id: r.id,
      file_path: r.file_path,
      chunk_index: r.chunk_index,
      title: r.title,
      section_title: r.section_title,
      category: r.category,
      content: r.content,
      similarity: r.similarity,
    })),
    total_found: results.length,
    index_stats: {
      total_chunks: stats.total_chunks,
      total_files: stats.total_files,
    },
    display,
  };
}
