import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { migrateLegacyAmemDb } from "../src/index.js";

const requireFn = createRequire(import.meta.url);

/**
 * Integration test for migrateLegacyAmemDb. We create a real legacy SQLite DB
 * with a memories table, populate it with rows that have legacy scope strings,
 * then run the migration and verify the new DB has canonical scopes.
 */
describe("migrateLegacyAmemDb", () => {
  let tmpRoot: string;
  let legacyDbPath: string;
  let engineDbPath: string;
  const originalEngineDbEnv = process.env.AMAN_ENGINE_DB;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aman-core-migrate-"));
    legacyDbPath = path.join(tmpRoot, "memory.db");
    engineDbPath = path.join(tmpRoot, "engine", "engine.db");
    process.env.AMAN_ENGINE_DB = engineDbPath;
  });

  afterEach(() => {
    if (originalEngineDbEnv === undefined) {
      delete process.env.AMAN_ENGINE_DB;
    } else {
      process.env.AMAN_ENGINE_DB = originalEngineDbEnv;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function createLegacyDbWithRows(
    rows: Array<{ id: string; scope: string | null }>,
  ): void {
    const Database = requireFn("better-sqlite3") as new (
      filename: string,
    ) => {
      prepare: (sql: string) => {
        run: (...params: unknown[]) => void;
      };
      close: () => void;
    };
    const db = new Database(legacyDbPath);
    try {
      db.prepare(
        `CREATE TABLE memories (id TEXT PRIMARY KEY, scope TEXT, content TEXT)`,
      ).run();
      const insert = db.prepare(
        `INSERT INTO memories (id, scope, content) VALUES (?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(row.id, row.scope, `content for ${row.id}`);
      }
    } finally {
      db.close();
    }
  }

  function readScopesFromEngineDb(): Map<string, string | null> {
    const Database = requireFn("better-sqlite3") as new (
      filename: string,
    ) => {
      prepare: (sql: string) => {
        all: () => Array<{ id: string; scope: string | null }>;
      };
      close: () => void;
    };
    const db = new Database(engineDbPath);
    try {
      const rows = db.prepare(`SELECT id, scope FROM memories`).all();
      return new Map(rows.map((r) => [r.id, r.scope]));
    } finally {
      db.close();
    }
  }

  function createEmptyLegacyDbNoMemoriesTable(): void {
    const Database = requireFn("better-sqlite3") as new (
      filename: string,
    ) => {
      prepare: (sql: string) => { run: () => void };
      close: () => void;
    };
    const db = new Database(legacyDbPath);
    try {
      db.prepare(`CREATE TABLE other (id TEXT)`).run();
    } finally {
      db.close();
    }
  }

  it("returns no-op when legacy DB does not exist", () => {
    const report = migrateLegacyAmemDb({ legacyDbPath });
    expect(report.status).toBe("no-op");
    expect(report.message).toMatch(/No legacy DB/);
  });

  it("copies and rewrites legacy scope strings to canonical form", () => {
    createLegacyDbWithRows([
      { id: "m1", scope: "global" },
      { id: "m2", scope: "myproject" },
      { id: "m3", scope: "tg:12345" },
      { id: "m4", scope: "dev:agent" },
      { id: "m5", scope: null },
      { id: "m6", scope: "" },
    ]);

    const report = migrateLegacyAmemDb({ legacyDbPath });
    expect(report.status).toBe("copied");
    expect(report.rowsRewrittenLegacyScope).toBe(4); // m1, m2, m5, m6 get rewritten
    expect(fs.existsSync(engineDbPath)).toBe(true);

    const scopes = readScopesFromEngineDb();
    expect(scopes.get("m1")).toBe("dev:default");      // global → dev:default
    expect(scopes.get("m2")).toBe("dev:myproject");    // bare name → dev:<name>
    expect(scopes.get("m3")).toBe("tg:12345");          // already canonical
    expect(scopes.get("m4")).toBe("dev:agent");         // already canonical
    expect(scopes.get("m5")).toBe("dev:default");       // null → dev:default
    expect(scopes.get("m6")).toBe("dev:default");       // empty → dev:default
  });

  it("is idempotent — running twice does not duplicate or corrupt", () => {
    createLegacyDbWithRows([{ id: "m1", scope: "global" }]);

    const first = migrateLegacyAmemDb({ legacyDbPath });
    expect(first.status).toBe("copied");

    const second = migrateLegacyAmemDb({ legacyDbPath });
    expect(second.status).toBe("no-op");
    expect(second.message).toMatch(/already exists/);

    const scopes = readScopesFromEngineDb();
    expect(scopes.size).toBe(1);
    expect(scopes.get("m1")).toBe("dev:default");
  });

  it("does not delete the legacy DB", () => {
    createLegacyDbWithRows([{ id: "m1", scope: "global" }]);
    migrateLegacyAmemDb({ legacyDbPath });
    expect(fs.existsSync(legacyDbPath)).toBe(true);
  });

  it("handles a legacy DB with no memories table gracefully", () => {
    createEmptyLegacyDbNoMemoriesTable();

    const report = migrateLegacyAmemDb({ legacyDbPath });
    expect(report.status).toBe("copied");
    expect(report.rowsRewrittenLegacyScope).toBe(0);
    expect(report.message).toMatch(/no 'memories' table/);
  });
});
