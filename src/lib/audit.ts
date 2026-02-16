/**
 * Audit logging for security-relevant operations
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CONFIG_DIR = resolve(
  process.env.XDG_CONFIG_HOME ?? resolve(process.env.HOME ?? "~", ".config"),
  "clai",
);
const AUDIT_LOG_PATH = resolve(CONFIG_DIR, "audit.log");

export interface AuditEntry {
  action: "tool_call" | "tool_approved" | "tool_denied" | "sensitive_file_access";
  toolName: string;
  input: Record<string, unknown>;
  result?: "success" | "error" | "denied";
  details?: string;
}

/** Redact credentials from URLs and sensitive values in audit inputs */
function sanitizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      // Redact credentials in URLs (user:pass@host)
      sanitized[key] = value.replace(/:\/\/[^@/]+@/g, "://[REDACTED]@");
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * Log an audit entry
 */
export function logAudit(entry: AuditEntry): void {
  try {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    }

    // Format as JSON for easy parsing
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      action: entry.action,
      toolName: entry.toolName,
      input: sanitizeInput(entry.input),
      ...(entry.result ? { result: entry.result } : {}),
      ...(entry.details ? { details: entry.details } : {}),
    });

    appendFileSync(AUDIT_LOG_PATH, line + "\n", { mode: 0o600 });
  } catch {
    // Don't throw - audit logging failure shouldn't break the app
  }
}

/**
 * Log a tool execution attempt
 */
export function logToolCall(toolName: string, input: Record<string, unknown>): void {
  logAudit({
    action: "tool_call",
    toolName,
    input,
  });
}

/**
 * Log tool approval
 */
export function logToolApproved(
  toolName: string,
  input: Record<string, unknown>,
  success: boolean,
  details?: string,
): void {
  logAudit({
    action: "tool_approved",
    toolName,
    input,
    result: success ? "success" : "error",
    details,
  });
}

/**
 * Log tool denial
 */
export function logToolDenied(toolName: string, input: Record<string, unknown>): void {
  logAudit({
    action: "tool_denied",
    toolName,
    input,
    result: "denied",
  });
}

/**
 * Log sensitive file access attempt
 */
export function logSensitiveFileAccess(
  toolName: string,
  filePath: string,
  approved: boolean,
): void {
  logAudit({
    action: "sensitive_file_access",
    toolName,
    input: { path: filePath },
    result: approved ? "success" : "denied",
  });
}

/**
 * Get audit log path for display
 */
export function getAuditLogPath(): string {
  return AUDIT_LOG_PATH;
}
