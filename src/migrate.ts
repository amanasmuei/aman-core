import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createRequire } from "node:module";
import { ensureDir, getEngineDbPath } from "./paths.js";
import { normalizeLegacyScope } from "./scope.js";

export interface MigrationReport {
  legacyDbPath: string;
  newDbPath: string;
  status: "no-op" | "copied" | "merged" | "error";
  message: string;
  rowsRewrittenLegacyScope?: number;
}

export interface MigrationOptions {
  /**
   * Override the legacy DB source path. Defaults to $AMEM_DB or
   * `~/.amem/memory.db` (the location aman-agent uses today).
   */
  legacyDbPath?: string;
  /**
   * If true, attempt to merge the legacy DB into an existing engine DB rather
   * than refusing the migration. NOT YET IMPLEMENTED — currently returns an
   * error if both DBs exist.
   */
  merge?: boolean;
}

/**
 * One-time migration from aman-agent's legacy `~/.amem/memory.db` to the
 * shared engine DB at `~/.aman/engine.db` (or wherever AMAN_ENGINE_DB points).
 *
 * Behavior:
 *   - If no legacy DB → no-op (nothing to migrate).
 *   - If legacy DB exists and engine DB does NOT → copy legacy → engine,
 *     then rewrite legacy scope strings to canonical form (`global` →
 *     `dev:default`, bare project names → `dev:<name>`).
 *   - If both exist and `merge` is false → no-op (refuse to overwrite).
 *   - If both exist and `merge` is true → not yet implemented.
 *
 * Idempotent: safe to call multiple times. Never deletes the legacy DB.
 *
 * Requires `better-sqlite3` to be installed at runtime (it's an optional
 * dependency of aman-core because aman-core itself stays storage-agnostic).
 * If you call this without `better-sqlite3` available, you'll get a clear
 * error message.
 */
export function migrateLegacyAmemDb(opts: MigrationOptions = {}): MigrationReport {
  const legacyDbPath =
    opts.legacyDbPath ??
    process.env.AMEM_DB ??
    path.join(os.homedir(), ".amem", "memory.db");
  const newDbPath = getEngineDbPath();

  if (!fs.existsSync(legacyDbPath)) {
    return {
      legacyDbPath,
      newDbPath,
      status: "no-op",
      message: `No legacy DB at ${legacyDbPath} — nothing to migrate.`,
    };
  }

  if (fs.existsSync(newDbPath) && !opts.merge) {
    return {
      legacyDbPath,
      newDbPath,
      status: "no-op",
      message: `Engine DB already exists at ${newDbPath}; pass { merge: true } to overlay (not yet implemented).`,
    };
  }

  if (fs.existsSync(newDbPath) && opts.merge) {
    return {
      legacyDbPath,
      newDbPath,
      status: "error",
      message: "merge mode requested but not yet implemented",
    };
  }

  ensureDir(path.dirname(newDbPath));

  // First-time migration: copy then rewrite legacy scopes in place.
  fs.copyFileSync(legacyDbPath, newDbPath);

  // Also copy WAL/SHM if present so the new DB starts in a consistent state.
  for (const ext of ["-wal", "-shm"]) {
    const src = legacyDbPath + ext;
    if (fs.existsSync(src)) {
      try {
        fs.copyFileSync(src, newDbPath + ext);
      } catch {
        // Best-effort; the WAL is an optimization, missing it isn't fatal.
      }
    }
  }

  let rewritten = 0;
  try {
    // Lazy require — better-sqlite3 is an optional dependency of aman-core
    // because aman-core itself stays storage-agnostic. amem-core (and any
    // other consumer that handles SQLite) brings it in as a real dep.
    const requireFn = createRequire(import.meta.url);
    const Database = requireFn("better-sqlite3") as new (
      filename: string,
    ) => {
      prepare: (sql: string) => {
        get: () => unknown;
        all: () => unknown[];
        run: (...params: unknown[]) => void;
      };
      transaction: <A extends unknown[]>(fn: (...args: A) => void) => (...args: A) => void;
      close: () => void;
    };

    const db = new Database(newDbPath);
    try {
      // Verify the memories table exists before touching it.
      const tableExists = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`,
        )
        .get();
      if (!tableExists) {
        return {
          legacyDbPath,
          newDbPath,
          status: "copied",
          message: `Copied ${legacyDbPath} → ${newDbPath}, but no 'memories' table found — nothing to rewrite.`,
          rowsRewrittenLegacyScope: 0,
        };
      }

      const select = db.prepare(`SELECT id, scope FROM memories`);
      const update = db.prepare(`UPDATE memories SET scope = ? WHERE id = ?`);

      const txn = db.transaction(
        (rows: { id: string; scope: string | null }[]) => {
          for (const row of rows) {
            const canonical = normalizeLegacyScope(row.scope);
            if (canonical !== row.scope) {
              update.run(canonical, row.id);
              rewritten++;
            }
          }
        },
      );

      const rows = select.all() as { id: string; scope: string | null }[];
      txn(rows);
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      legacyDbPath,
      newDbPath,
      status: "error",
      message: `Copied DB but failed to rewrite legacy scopes: ${
        err instanceof Error ? err.message : String(err)
      }. If 'better-sqlite3' is not installed, install it and re-run.`,
    };
  }

  return {
    legacyDbPath,
    newDbPath,
    status: "copied",
    message: `Migrated ${legacyDbPath} → ${newDbPath} (${rewritten} legacy scope rows rewritten to canonical form).`,
    rowsRewrittenLegacyScope: rewritten,
  };
}
