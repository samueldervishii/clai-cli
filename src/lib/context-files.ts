/**
 * Project context file support (.claicontext and .claiignore)
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

// Max .claicontext size: 5KB (prevents oversized context and prompt injection)
const MAX_CONTEXT_FILE_SIZE = 5 * 1024;

/**
 * Load .claicontext file from current working directory
 * Returns the content to be appended to system prompt, or null if not found
 */
export function loadContextFile(): string | null {
  const contextPath = resolve(process.cwd(), ".claicontext");

  if (!existsSync(contextPath)) {
    return null;
  }

  try {
    // Enforce file size limit
    const stat = statSync(contextPath);
    if (stat.size > MAX_CONTEXT_FILE_SIZE) {
      console.error(
        `.claicontext too large (${Math.round(stat.size / 1024)}KB, max ${MAX_CONTEXT_FILE_SIZE / 1024}KB) — skipped`,
      );
      return null;
    }

    const content = readFileSync(contextPath, "utf-8").trim();
    if (!content) return null;

    // Return formatted context to be appended to system prompt
    return `\n\n## Project Context (from .claicontext)\n\n${content}`;
  } catch (error) {
    console.error("Error reading .claicontext:", error);
    return null;
  }
}

/**
 * Load .claiignore patterns from current working directory
 * Returns array of glob patterns to ignore, or empty array if not found
 */
export function loadIgnorePatterns(): string[] {
  const ignorePath = resolve(process.cwd(), ".claiignore");

  if (!existsSync(ignorePath)) {
    return [];
  }

  try {
    const content = readFileSync(ignorePath, "utf-8");

    // Parse line by line, skip empty lines and comments
    return content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    console.error("Error reading .claiignore:", error);
    return [];
  }
}

/**
 * Check if a file path should be ignored based on .claiignore patterns
 */
export function shouldIgnoreFile(filePath: string, ignorePatterns: string[]): boolean {
  if (ignorePatterns.length === 0) return false;

  // Normalize path for comparison (remove leading ./)
  const normalizedPath = filePath.replace(/^\.\//, "");

  for (const pattern of ignorePatterns) {
    // Convert glob pattern to regex
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // Escape regex special chars
      .replace(/\*\*/g, ".*") // ** matches any path
      .replace(/\*/g, "[^/]*") // * matches anything except /
      .replace(/\?/g, "."); // ? matches single char

    const regex = new RegExp(`^${regexPattern}$`);

    if (regex.test(normalizedPath)) {
      return true;
    }

    // Also check if path starts with pattern (for directory matching)
    if (normalizedPath.startsWith(pattern.replace(/\/$/, ""))) {
      return true;
    }
  }

  return false;
}
