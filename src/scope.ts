import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Scope is a colon-delimited string identifying who/where in the aman ecosystem.
 *
 *   <frontend>:<id>[:<sub>...]
 *
 * Canonical examples:
 *   dev:default              the default identity for the local developer
 *   dev:agent                memories/identity from aman-agent CLI runtime
 *   dev:plugin               memories/identity from aman-plugin (Claude Code)
 *   dev:cli                  memories/identity from a generic CLI session
 *   tg:12345                 Telegram user 12345 (used by aman-tg)
 *   agent:jiran              Jiran the agent's persona (global, not per-user)
 *   tg:12345:agent:jiran     user 12345's view/version of Jiran
 *
 * Why a string and not a struct? Three reasons:
 *   1. aman-tg already uses `tg:${telegramId}` in production. Zero migration.
 *   2. Wire format stays stable across all storage backends and MCP boundaries.
 *   3. Strings serialize trivially through MCP request metadata.
 *
 * If callers need the components, use `parseScope()` to get a struct view.
 */
export type Scope = string;

export interface ParsedScope {
  /** First segment, e.g. 'dev', 'tg', 'agent'. */
  frontend: string;
  /** Second segment, e.g. 'default', '12345', 'jiran'. */
  id: string;
  /** All segments split on ':'. */
  parts: string[];
  /** The original raw scope string. */
  raw: Scope;
}

/**
 * Parse a scope into its components.
 *
 *   parseScope('tg:12345:agent:jiran')
 *     → { frontend: 'tg', id: '12345', parts: ['tg','12345','agent','jiran'], raw: ... }
 *
 * Bare strings (no colon) are treated as legacy project names and normalized:
 *   parseScope('myproject') → { frontend: 'dev', id: 'myproject', ... }
 */
export function parseScope(scope: Scope): ParsedScope {
  if (!scope || typeof scope !== "string") {
    throw new TypeError(
      `scope must be a non-empty string, got ${typeof scope}`,
    );
  }
  const parts = scope.split(":");
  if (parts.length < 2) {
    // Backward compat: bare names like "global" or "myproject" become dev:<name>
    const id = parts[0] || "default";
    return {
      frontend: "dev",
      id,
      parts: ["dev", id],
      raw: scope,
    };
  }
  return {
    frontend: parts[0],
    id: parts[1],
    parts,
    raw: scope,
  };
}

/**
 * Build a scope string from components. Throws if any segment contains ':'.
 *
 *   formatScope({ frontend: 'tg', id: '12345' }) → 'tg:12345'
 *   formatScope({ frontend: 'tg', id: '12345', sub: ['agent', 'jiran'] }) → 'tg:12345:agent:jiran'
 */
export function formatScope(opts: {
  frontend: string;
  id: string;
  sub?: string[];
}): Scope {
  const segments = [opts.frontend, opts.id, ...(opts.sub ?? [])];
  for (const s of segments) {
    if (typeof s !== "string" || s.length === 0) {
      throw new Error(`scope segment must be a non-empty string`);
    }
    if (s.includes(":")) {
      throw new Error(`scope segment cannot contain ':' (got "${s}")`);
    }
  }
  return segments.join(":");
}

/**
 * Convert pre-tenancy scope strings to canonical form. Used by the migration
 * script and by any code path that might receive an unnormalized string from
 * a legacy database row.
 *
 *   normalizeLegacyScope('global')      → 'dev:default'
 *   normalizeLegacyScope('myproject')   → 'dev:myproject'
 *   normalizeLegacyScope('tg:12345')    → 'tg:12345'  (already canonical)
 *   normalizeLegacyScope('dev:agent')   → 'dev:agent' (already canonical)
 *   normalizeLegacyScope('')            → 'dev:default'
 */
export function normalizeLegacyScope(legacyScope: string | null | undefined): Scope {
  if (!legacyScope || legacyScope === "global") return "dev:default";
  if (legacyScope.includes(":")) return legacyScope; // already namespaced
  return `dev:${legacyScope}`;
}

// ── AsyncLocalStorage scope propagation ──────────────────────────────────────
//
// Hosts (aman-plugin, aman-agent, aman-tg backend) wrap their per-session
// entry points in `withScope(scope, async () => { ... })`. Layer code inside
// the closure reads the current scope via `getCurrentScope()` without needing
// to thread it through every signature.
//
// Example:
//   await withScope('dev:agent', async () => {
//     await amem.recall('what do i know about pnpm');  // implicit scope
//   });

const scopeStorage = new AsyncLocalStorage<Scope>();

/**
 * Run an async function with an active scope. Calls inside `fn` (and any
 * async work it spawns) can read the current scope via `getCurrentScope()`.
 *
 * Returns whatever `fn` returns.
 */
export function withScope<T>(scope: Scope, fn: () => Promise<T>): Promise<T>;
export function withScope<T>(scope: Scope, fn: () => T): T;
export function withScope<T>(scope: Scope, fn: () => T | Promise<T>): T | Promise<T> {
  return scopeStorage.run(scope, fn);
}

/**
 * Read the active scope. Throws if no `withScope()` block is active.
 * Use `getCurrentScopeOr(fallback)` if you want a default instead.
 */
export function getCurrentScope(): Scope {
  const scope = scopeStorage.getStore();
  if (!scope) {
    throw new Error(
      "no active scope — wrap your code in withScope() or use getCurrentScopeOr()",
    );
  }
  return scope;
}

/**
 * Read the active scope, or return `fallback` if no `withScope()` block is active.
 */
export function getCurrentScopeOr(fallback: Scope): Scope {
  return scopeStorage.getStore() ?? fallback;
}

/**
 * Returns true if a `withScope()` block is currently active.
 */
export function hasActiveScope(): boolean {
  return scopeStorage.getStore() !== undefined;
}
