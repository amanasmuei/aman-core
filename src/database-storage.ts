import * as path from "node:path";
import { createRequire } from "node:module";
import type { Scope } from "./scope.js";
import type { Storage, StorageWithLocation } from "./storage.js";
import { ensureDir, getEngineDbPath } from "./paths.js";

const requireFn = createRequire(import.meta.url);

/**
 * Minimal subset of better-sqlite3's API that DatabaseStorage uses. We declare
 * the types locally so aman-core stays free of a hard @types/better-sqlite3
 * dependency. Consumers that already pull in better-sqlite3 (amem-core, the
 * aman-tg backend) get the real types from their own deps.
 */
interface SqliteStatement {
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  run: (...params: unknown[]) => { changes: number; lastInsertRowid: number };
}
interface SqliteDatabase {
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
  pragma: (pragma: string) => void;
}
type SqliteCtor = new (filename: string) => SqliteDatabase;

/**
 * Configuration for a DatabaseStorage instance.
 *
 * Each layer (acore-core, arules-core, ...) gets its own table inside the
 * shared engine DB at `~/.aman/engine.db` (or wherever AMAN_ENGINE_DB points).
 * The table layout is fixed:
 *
 *   CREATE TABLE {tableName} (
 *     scope       TEXT PRIMARY KEY,
 *     content     TEXT NOT NULL,
 *     updated_at  INTEGER NOT NULL
 *   );
 *
 * The `content` column holds the serialized form of T (typically markdown
 * for layers like acore, or JSON for structured layers).
 */
export interface DatabaseStorageOptions<T> {
  /**
   * Path to the SQLite DB file. Defaults to `getEngineDbPath()`.
   */
  dbPath?: string;

  /**
   * Table name for this layer's records. Must be a valid SQL identifier
   * (alphanumerics + underscore). Examples: `"acore_identities"`,
   * `"arules_rulesets"`.
   */
  tableName: string;

  /**
   * Convert a typed record T to the string written to the `content` column.
   */
  serialize: (value: T) => string;

  /**
   * Parse the `content` column back into a typed record T.
   */
  deserialize: (raw: string) => T;

  /**
   * Custom patch logic. If omitted, `patch` defaults to a shallow object
   * merge: `{ ...current, ...partial }`.
   */
  applyPatch?: (current: T, partial: Partial<T>) => T;
}

const TABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A `Storage<T>` backend that persists records in a SQLite database.
 *
 * Use this for high-volume / multi-tenant scopes (`tg:*`, `agent:*`, server
 * deployments). For dev-side scopes where human editing matters, use
 * `MarkdownFileStorage<T>` instead.
 *
 * Each instance opens its own better-sqlite3 connection. Connections are
 * cheap and SQLite handles concurrent readers natively, so per-instance
 * connections are fine for single-process workloads. If you need to share
 * a connection across many instances of the same DB, do it at the layer
 * level by reusing one DatabaseStorage per (dbPath, tableName) pair.
 */
export class DatabaseStorage<T> implements Storage<T>, StorageWithLocation {
  private readonly dbPath: string;
  private readonly tableName: string;
  private db: SqliteDatabase | null = null;
  private statements: {
    get: SqliteStatement;
    upsert: SqliteStatement;
    delete: SqliteStatement;
    listScopes: SqliteStatement;
  } | null = null;

  constructor(private readonly opts: DatabaseStorageOptions<T>) {
    if (!TABLE_NAME_PATTERN.test(opts.tableName)) {
      throw new Error(
        `DatabaseStorage tableName must match ${TABLE_NAME_PATTERN}, got "${opts.tableName}"`,
      );
    }
    this.dbPath = opts.dbPath ?? getEngineDbPath();
    this.tableName = opts.tableName;
  }

  async get(scope: Scope): Promise<T | null> {
    const stmts = this.ensureOpen();
    const row = stmts.get.get(scope) as { content: string } | undefined;
    if (!row) return null;
    return this.opts.deserialize(row.content);
  }

  async put(scope: Scope, value: T): Promise<void> {
    const stmts = this.ensureOpen();
    const content = this.opts.serialize(value);
    stmts.upsert.run(scope, content, Date.now());
  }

  async patch(scope: Scope, partial: Partial<T>): Promise<void> {
    const current = await this.get(scope);
    let merged: T;
    if (current === null) {
      merged = partial as T;
    } else if (this.opts.applyPatch) {
      merged = this.opts.applyPatch(current, partial);
    } else {
      merged = { ...(current as object), ...(partial as object) } as T;
    }
    await this.put(scope, merged);
  }

  async delete(scope: Scope): Promise<void> {
    const stmts = this.ensureOpen();
    stmts.delete.run(scope);
  }

  async listScopes(): Promise<Scope[]> {
    const stmts = this.ensureOpen();
    const rows = stmts.listScopes.all() as Array<{ scope: string }>;
    return rows.map((r) => r.scope);
  }

  /**
   * Close the underlying SQLite connection. Optional — most callers can let
   * the process exit handle cleanup. Call this in tests to free temp files.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.statements = null;
    }
  }

  location(): string {
    return `${this.dbPath} (table: ${this.tableName})`;
  }

  private ensureOpen(): NonNullable<typeof this.statements> {
    if (this.statements && this.db) return this.statements;

    ensureDir(path.dirname(this.dbPath));

    const Database = requireFn("better-sqlite3") as SqliteCtor;
    this.db = new Database(this.dbPath);

    // Enable WAL for safer concurrent reads. Idempotent.
    try {
      this.db.pragma("journal_mode = WAL");
    } catch {
      // Some environments (in-memory DBs) don't support WAL — ignore.
    }

    // Create the layer's table if it doesn't exist. The table layout is fixed
    // by aman-core so all layers share the same shape.
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${this.tableName} (
          scope       TEXT PRIMARY KEY,
          content     TEXT NOT NULL,
          updated_at  INTEGER NOT NULL
        )`,
      )
      .run();

    this.statements = {
      get: this.db.prepare(
        `SELECT content FROM ${this.tableName} WHERE scope = ?`,
      ),
      upsert: this.db.prepare(
        `INSERT INTO ${this.tableName} (scope, content, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
      ),
      delete: this.db.prepare(`DELETE FROM ${this.tableName} WHERE scope = ?`),
      listScopes: this.db.prepare(
        `SELECT scope FROM ${this.tableName} ORDER BY scope`,
      ),
    };
    return this.statements;
  }
}
