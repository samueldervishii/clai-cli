import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { resolve, relative, join, dirname } from "node:path";
import { validatePath, validateFileSize, getWorkingDirectory } from "./sandbox.js";
import { loadIgnorePatterns, shouldIgnoreFile } from "./context-files.js";
import type Anthropic from "@anthropic-ai/sdk";
import { execSync } from "node:child_process";

// Tool definitions for the Anthropic API
export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "Read the contents of a file. Path is relative to the working directory. Cannot read sensitive files (.env, keys, credentials) or files outside the working directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to read",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description:
      "List files and directories at the given path. Path is relative to the working directory. Returns file names with type indicators (/ for directories).",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path to the directory to list (default: current directory)",
        },
      },
      required: [],
    },
  },
  {
    name: "search_files",
    description:
      "Search for files matching a pattern in the working directory. Returns relative file paths.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: {
          type: "string",
          description: "File name pattern to search for (e.g. '*.ts', 'package.json')",
        },
        path: {
          type: "string",
          description:
            "Directory to search in, relative to working directory (default: current directory)",
        },
      },
      required: ["pattern"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file. Path is relative to the working directory. Cannot write to sensitive files or outside the working directory. Use this to create new files or overwrite existing ones.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file to write",
        },
        content: {
          type: "string",
          description: "Content to write to the file",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "web_fetch",
    description:
      "Fetch the text content of a webpage. Returns the page text (HTML stripped). Use this when the user asks about a URL or you need to look something up online.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "run_command",
    description:
      "Execute a shell command in the working directory. Returns stdout and stderr. Use this for running tests, linters, builds, git commands, etc. Some commands are blocked for security (network, privilege escalation, destructive). Requires user approval by default.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
      },
      required: ["command"],
    },
  },
];

export interface ToolResult {
  output: string;
  isError: boolean;
  requiresApproval?: boolean; // If true, tool needs user approval before execution
}

export function executeTool(
  name: string,
  input: Record<string, unknown>,
  skipApprovalCheck = false,
): ToolResult {
  switch (name) {
    case "read_file": {
      if (typeof input.path !== "string")
        return { output: "Missing or invalid 'path'", isError: true };
      return readFile(input.path, skipApprovalCheck);
    }
    case "list_dir": {
      const dir = typeof input.path === "string" ? input.path : ".";
      return listDir(dir);
    }
    case "search_files": {
      if (typeof input.pattern !== "string")
        return { output: "Missing or invalid 'pattern'", isError: true };
      const dir = typeof input.path === "string" ? input.path : ".";
      return searchFiles(input.pattern, dir);
    }
    case "write_file": {
      if (typeof input.path !== "string")
        return { output: "Missing or invalid 'path'", isError: true };
      if (typeof input.content !== "string")
        return { output: "Missing or invalid 'content'", isError: true };
      return writeFile(input.path, input.content);
    }
    case "web_fetch": {
      if (typeof input.url !== "string") {
        return { output: "Missing or invalid 'url'", isError: true };
      }
      return webFetch(input.url);
    }
    case "run_command": {
      if (typeof input.command !== "string")
        return { output: "Missing or invalid 'command'", isError: true };
      return runCommand(input.command);
    }
    default:
      return { output: `Unknown tool: ${name}`, isError: true };
  }
}

function readFile(filePath: string, skipApprovalCheck = false): ToolResult {
  const cwd = getWorkingDirectory();
  const absPath = resolve(cwd, filePath);

  const pathCheck = validatePath(absPath);
  if (!pathCheck.allowed) {
    return { output: pathCheck.reason!, isError: true };
  }

  // If file is sensitive and approval check is not skipped, request approval
  if (pathCheck.requiresApproval && !skipApprovalCheck) {
    const relPath = relative(cwd, absPath);
    return {
      output: `File "${relPath}" may contain sensitive data (credentials, secrets, etc.)`,
      isError: false,
      requiresApproval: true,
    };
  }

  const sizeCheck = validateFileSize(absPath);
  if (!sizeCheck.allowed) {
    return { output: sizeCheck.reason!, isError: true };
  }

  try {
    const content = readFileSync(absPath, "utf-8");
    const relPath = relative(cwd, absPath);
    return { output: `File: ${relPath}\n\n${content}`, isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error reading file: ${msg}`, isError: true };
  }
}

function listDir(dirPath: string): ToolResult {
  const cwd = getWorkingDirectory();
  const absPath = resolve(cwd, dirPath);

  const pathCheck = validatePath(absPath);
  if (!pathCheck.allowed) {
    return { output: pathCheck.reason!, isError: true };
  }

  try {
    const entries = readdirSync(absPath);
    const result = entries
      .map((entry) => {
        try {
          const stat = statSync(join(absPath, entry));
          return stat.isDirectory() ? `${entry}/` : entry;
        } catch {
          return entry;
        }
      })
      .join("\n");

    const relPath = relative(cwd, absPath) || ".";
    return { output: `Directory: ${relPath}\n\n${result}`, isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error listing directory: ${msg}`, isError: true };
  }
}

function searchFiles(pattern: string, dirPath: string): ToolResult {
  const cwd = getWorkingDirectory();
  const absPath = resolve(cwd, dirPath);

  const pathCheck = validatePath(absPath);
  if (!pathCheck.allowed) {
    return { output: pathCheck.reason!, isError: true };
  }

  try {
    // Load .claiignore patterns
    const ignorePatterns = loadIgnorePatterns();

    const matches: string[] = [];
    searchRecursive(absPath, pattern, matches, cwd, 0, ignorePatterns);

    if (matches.length === 0) {
      return { output: `No files matching "${pattern}" found.`, isError: false };
    }

    return {
      output: `Found ${matches.length} file(s):\n\n${matches.join("\n")}`,
      isError: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error searching: ${msg}`, isError: true };
  }
}

function searchRecursive(
  dir: string,
  pattern: string,
  matches: string[],
  cwd: string,
  depth: number,
  ignorePatterns: string[] = [],
): void {
  if (depth > 5 || matches.length >= 50) return; // Limit depth and results

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;

      const fullPath = join(dir, entry);
      const relPath = relative(cwd, fullPath);

      // Check if path should be ignored per .claiignore
      if (shouldIgnoreFile(relPath, ignorePatterns)) continue;

      const pathCheck = validatePath(fullPath);
      if (!pathCheck.allowed) continue;

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          searchRecursive(fullPath, pattern, matches, cwd, depth + 1, ignorePatterns);
        } else if (matchesPattern(entry, pattern)) {
          matches.push(relPath);
        }
      } catch {
        // Skip inaccessible entries
      }
    }
  } catch {
    // Skip inaccessible directories
  }
}

function matchesPattern(filename: string, pattern: string): boolean {
  // Extract the filename portion if pattern contains path separators
  // e.g. "**/*.ts" → "*.ts", "src/**/*.json" → "*.json"
  const filePattern = pattern.includes("/") ? pattern.split("/").pop()! : pattern;

  const regex = new RegExp(
    "^" +
      filePattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*") // ** matches anything
        .replace(/\*/g, "[^/]*") // * matches anything except path sep
        .replace(/\?/g, ".") +
      "$",
    "i",
  );
  return regex.test(filename);
}

function writeFile(filePath: string, content: string): ToolResult {
  const cwd = getWorkingDirectory();
  const absPath = resolve(cwd, filePath);

  const pathCheck = validatePath(absPath);
  if (!pathCheck.allowed) {
    return { output: pathCheck.reason!, isError: true };
  }

  // Extra safety: must be within CWD
  if (!absPath.startsWith(cwd)) {
    return { output: "Access denied: cannot write outside working directory", isError: true };
  }

  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content);
    const relPath = relative(cwd, absPath);
    return { output: `Written: ${relPath} (${content.length} chars)`, isError: false };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Error writing file: ${msg}`, isError: true };
  }
}

// Commands that are always blocked regardless of permission settings
const BLOCKED_COMMAND_PATTERNS = [
  // Destructive
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+-[a-zA-Z]*r|(-[a-zA-Z]*r[a-zA-Z]*\s+-[a-zA-Z]*f))\b/, // rm -rf variants
  /\brm\s+-[a-zA-Z]*rf\b/, // rm -rf combined
  /\bmkfs\b/,
  /\bdd\s+if=/,
  // Privilege escalation
  /\bsudo\b/,
  /\bsu\s/,
  /\bchmod\b/,
  /\bchown\b/,
  // Network / exfiltration
  /\bcurl\b/,
  /\bwget\b/,
  /\bnc\s/,
  /\bncat\b/,
  /\bssh\b/,
  /\bscp\b/,
  /\brsync\b/,
  // System
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bpoweroff\b/,
  /\binit\s+[0-6]\b/,
  // Backgrounding
  /&\s*$/,
  /\bnohup\b/,
  /\bdisown\b/,
];

const MAX_COMMAND_TIMEOUT = 30_000; // 30 seconds
const MAX_OUTPUT_SIZE = 10_000; // 10KB output cap

function runCommand(command: string): ToolResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { output: "Empty command", isError: true };
  }

  // Check against blocked patterns
  for (const pattern of BLOCKED_COMMAND_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        output: `Command blocked for security: matches restricted pattern. Blocked categories: destructive ops, privilege escalation, network access, backgrounding.`,
        isError: true,
      };
    }
  }

  const cwd = getWorkingDirectory();

  try {
    const result = execSync(trimmed, {
      cwd,
      encoding: "utf-8",
      timeout: MAX_COMMAND_TIMEOUT,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      stdio: ["pipe", "pipe", "pipe"],
    });

    const output =
      result.length > MAX_OUTPUT_SIZE
        ? result.slice(0, MAX_OUTPUT_SIZE) + "\n\n[Output truncated at 10KB]"
        : result;

    return { output: output || "(no output)", isError: false };
  } catch (err: unknown) {
    if (err && typeof err === "object" && "killed" in err && (err as { killed: boolean }).killed) {
      return { output: `Command timed out after ${MAX_COMMAND_TIMEOUT / 1000}s`, isError: true };
    }
    // execSync throws on non-zero exit — capture stderr/stdout from the error
    if (err && typeof err === "object" && "stderr" in err) {
      const execErr = err as { stdout?: string; stderr?: string; status?: number };
      const stderr = typeof execErr.stderr === "string" ? execErr.stderr : "";
      const stdout = typeof execErr.stdout === "string" ? execErr.stdout : "";
      const combined = (stdout + "\n" + stderr).trim();
      const output =
        combined.length > MAX_OUTPUT_SIZE
          ? combined.slice(0, MAX_OUTPUT_SIZE) + "\n\n[Output truncated at 10KB]"
          : combined;
      return {
        output: `Exit code ${execErr.status ?? 1}:\n${output || "(no output)"}`,
        isError: true,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Command failed: ${msg}`, isError: true };
  }
}

function webFetch(url: string): ToolResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { output: "Invalid URL", isError: true };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return {
      output: "Only HTTP/HTTPS URLs are supported",
      isError: true,
    };
  }

  // SSRF Protection: Block private IPs and localhost
  const hostname = parsed.hostname.toLowerCase();
  const privatePatterns = [
    /^localhost$/i,
    /^127\./, // IPv4 loopback
    /^0\./, // 0.0.0.0/8
    /^10\./, // 10.0.0.0/8
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
    /^192\.168\./, // 192.168.0.0/16
    /^169\.254\./, // link-local
    /^255\.255\.255\.255$/, // broadcast
    /^::1$/, // IPv6 localhost
    /^\[::1\]$/, // IPv6 localhost bracketed
    /^fe80:/i, // IPv6 link-local
    /^fc00:/i, // IPv6 unique local (fc00::/7)
    /^fd[0-9a-f]{2}:/i, // IPv6 unique local (fd00::/8)
  ];

  if (privatePatterns.some((pattern) => pattern.test(hostname))) {
    return {
      output: "Access to private networks and localhost is not allowed",
      isError: true,
    };
  }

  try {
    //Use curl for simplicity - available on virtually all systems
    const result = execSync(
      `curl -sL -m 10 --max-filesize 500000 -H "User-Agent: Clai/1.0" ${JSON.stringify(url)}`,
      { encoding: "utf-8", timeout: 15000 },
    );

    // Strip HTML to plain text using indexOf-based removal for script/style
    // (avoids multi-character regex patterns flagged by CodeQL)
    let text = result;
    for (const tag of ["script", "style"]) {
      let lower = text.toLowerCase();
      let start = lower.indexOf(`<${tag}`);
      while (start !== -1) {
        const end = lower.indexOf(`</${tag}`, start);
        if (end === -1) {
          text = text.slice(0, start);
          break;
        }
        const closeEnd = lower.indexOf(">", end);
        if (closeEnd === -1) {
          text = text.slice(0, start);
          break;
        }
        text = text.slice(0, start) + text.slice(closeEnd + 1);
        lower = text.toLowerCase();
        start = lower.indexOf(`<${tag}`);
      }
    }
    text = text
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) {
      return { output: "Page returned no readable content.", isError: false };
    }

    // Truncate to keep token usage resonable
    const truncated = text.length > 8000 ? text.slice(0, 8000) + "\n\n[Truncated]" : text;
    return {
      output: `Content from ${parsed.hostname}:\n\n${truncated}`,
      isError: false,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to fetch URL ${msg}`, isError: true };
  }
}
