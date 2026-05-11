/**
 * Document Chunker — Split markdown files into searchable chunks
 *
 * Strategy:
 * 1. Split on H2 headers first (natural semantic boundaries)
 * 2. If a section exceeds target size, split on paragraph boundaries
 * 3. Each chunk carries metadata: file path, title, category, chunk index
 *
 * Target chunk size: 500-800 tokens (~2000-3200 chars)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const TARGET_CHUNK_CHARS = 2400; // ~600 tokens
const MAX_CHUNK_CHARS = 3600; // ~900 tokens hard limit
const MIN_CHUNK_CHARS = 200; // Don't create tiny chunks

export interface DocChunk {
  file_path: string; // Relative path from scan root
  chunk_index: number;
  title: string; // H1 or filename
  section_title: string; // H2 header for this chunk (or "")
  category: string; // Directory name (e.g., "research", "architecture")
  content: string; // The chunk text
  file_hash: string; // SHA-256 of full file content (for change detection)
}

export interface DocFile {
  absolute_path: string;
  relative_path: string;
  content: string;
  hash: string;
}

/**
 * Extract title from markdown content (first H1, or filename)
 */
function extractTitle(content: string, filePath: string): string {
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  // Fall back to filename without extension
  return path.basename(filePath, ".md").replace(/[-_]/g, " ");
}

/**
 * Extract category from directory structure
 */
function extractCategory(relativePath: string): string {
  const parts = relativePath.split(path.sep);
  if (parts.length > 1) return parts[0];
  return "root";
}

/**
 * Split markdown into sections by H2 headers
 */
function splitByH2(content: string): Array<{ title: string; content: string }> {
  const sections: Array<{ title: string; content: string }> = [];
  const lines = content.split("\n");
  let currentTitle = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    const h2Match = line.match(/^##\s+(.+)$/);
    if (h2Match) {
      // Save previous section if it has content
      if (currentLines.length > 0) {
        const text = currentLines.join("\n").trim();
        if (text.length > 0) {
          sections.push({ title: currentTitle, content: text });
        }
      }
      currentTitle = h2Match[1].trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Don't forget the last section
  if (currentLines.length > 0) {
    const text = currentLines.join("\n").trim();
    if (text.length > 0) {
      sections.push({ title: currentTitle, content: text });
    }
  }

  return sections;
}

/**
 * Split a text blob on paragraph boundaries to fit within target size
 */
function splitByParagraphs(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current.trim().length > 0) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Compute SHA-256 hash of content
 */
function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Chunk a single markdown file into searchable segments
 */
export function chunkDocument(doc: DocFile): DocChunk[] {
  const title = extractTitle(doc.content, doc.relative_path);
  const category = extractCategory(doc.relative_path);
  const chunks: DocChunk[] = [];
  let chunkIndex = 0;

  // Split by H2 headers
  const sections = splitByH2(doc.content);

  for (const section of sections) {
    // If section fits in one chunk, use it directly
    if (section.content.length <= MAX_CHUNK_CHARS) {
      if (section.content.length >= MIN_CHUNK_CHARS) {
        chunks.push({
          file_path: doc.relative_path,
          chunk_index: chunkIndex++,
          title,
          section_title: section.title,
          category,
          content: section.content,
          file_hash: doc.hash,
        });
      }
    } else {
      // Section too large — split by paragraphs
      const subChunks = splitByParagraphs(section.content, TARGET_CHUNK_CHARS);
      for (const sub of subChunks) {
        if (sub.length >= MIN_CHUNK_CHARS) {
          chunks.push({
            file_path: doc.relative_path,
            chunk_index: chunkIndex++,
            title,
            section_title: section.title,
            category,
            content: sub,
            file_hash: doc.hash,
          });
        }
      }
    }
  }

  // Edge case: file with no H2 headers and short content — one chunk
  if (chunks.length === 0 && doc.content.trim().length >= MIN_CHUNK_CHARS) {
    chunks.push({
      file_path: doc.relative_path,
      chunk_index: 0,
      title,
      section_title: "",
      category,
      content: doc.content.trim().slice(0, MAX_CHUNK_CHARS),
      file_hash: doc.hash,
    });
  }

  return chunks;
}

/**
 * Scan a directory for markdown files
 */
export function scanDirectory(
  dirPath: string,
  options: { exclude?: string[] } = {}
): DocFile[] {
  const exclude = options.exclude || ["_archive", "node_modules", ".git"];
  const files: DocFile[] = [];

  function walk(currentPath: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return; // Permission denied or inaccessible
    }

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);

      if (entry.isDirectory()) {
        if (!exclude.includes(entry.name)) {
          walk(fullPath);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const relativePath = path.relative(dirPath, fullPath);
          files.push({
            absolute_path: fullPath,
            relative_path: relativePath,
            content,
            hash: hashContent(content),
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(dirPath);
  return files;
}

/**
 * Chunk all markdown files in a directory
 */
export function chunkDirectory(
  dirPath: string,
  options: { exclude?: string[] } = {}
): { files: DocFile[]; chunks: DocChunk[] } {
  const files = scanDirectory(dirPath, options);
  const chunks: DocChunk[] = [];

  for (const file of files) {
    chunks.push(...chunkDocument(file));
  }

  return { files, chunks };
}
