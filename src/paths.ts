import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import type { Scope } from "./scope.js";

/**
 * Default location of the shared aman engine database.
 *
 * All dev-side frontends (aman-agent, aman-plugin) point here so memories
 * stored in one are recallable in the other. The aman-tg backend uses its
 * own DB at `apps/api/data/amem.db` because it lives on a different host.
 *
 * Override with the `AMAN_ENGINE_DB` environment variable.
 */
export function getEngineDbPath(): string {
  if (process.env.AMAN_ENGINE_DB) {
    return process.env.AMAN_ENGINE_DB;
  }
  return path.join(os.homedir(), ".aman", "engine.db");
}

/**
 * Default root for human-editable layer files (acore markdown, arules markdown).
 * Used by MarkdownFileStorage as the base directory.
 *
 * Override with the `AMAN_HOME` environment variable.
 */
export function getAmanHome(): string {
  if (process.env.AMAN_HOME) {
    return process.env.AMAN_HOME;
  }
  return path.join(os.homedir(), ".aman");
}

/**
 * Ensure a directory exists. Idempotent. Creates intermediate directories.
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Convert a scope into a filesystem-safe directory path.
 *
 *   scopeToPath('dev:default')         → 'dev/default'
 *   scopeToPath('tg:12345:agent:jiran') → 'tg/12345/agent/jiran'
 *
 * Each segment is sanitized to allow only [A-Za-z0-9._-]. Disallowed
 * characters become '_' so the function never throws on user-supplied IDs.
 */
export function scopeToPath(scope: Scope): string {
  return scope
    .split(":")
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "_"))
    .join(path.sep);
}
