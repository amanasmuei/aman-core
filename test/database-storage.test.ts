import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { DatabaseStorage } from "../src/index.js";

interface Identity {
  content: string;
}

const identityCodec = {
  serialize: (v: Identity) => v.content,
  deserialize: (raw: string): Identity => ({ content: raw }),
};

describe("DatabaseStorage", () => {
  let tmpRoot: string;
  let dbPath: string;
  let storage: DatabaseStorage<Identity>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aman-dbs-"));
    dbPath = path.join(tmpRoot, "engine.db");
    storage = new DatabaseStorage<Identity>({
      dbPath,
      tableName: "test_identities",
      ...identityCodec,
    });
  });

  afterEach(() => {
    storage.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("constructor validation", () => {
    it("throws on invalid table name with hyphens", () => {
      expect(
        () =>
          new DatabaseStorage<Identity>({
            dbPath,
            tableName: "bad-name",
            ...identityCodec,
          }),
      ).toThrow(/tableName must match/);
    });

    it("throws on table name starting with a digit", () => {
      expect(
        () =>
          new DatabaseStorage<Identity>({
            dbPath,
            tableName: "1table",
            ...identityCodec,
          }),
      ).toThrow();
    });

    it("throws on table name with SQL injection attempt", () => {
      expect(
        () =>
          new DatabaseStorage<Identity>({
            dbPath,
            tableName: "users; DROP TABLE x;--",
            ...identityCodec,
          }),
      ).toThrow();
    });

    it("accepts valid identifiers", () => {
      expect(
        () =>
          new DatabaseStorage<Identity>({
            dbPath,
            tableName: "valid_table_123",
            ...identityCodec,
          }),
      ).not.toThrow();
    });
  });

  describe("get", () => {
    it("returns null when no row exists", async () => {
      expect(await storage.get("dev:default")).toBeNull();
    });

    it("returns parsed record after put", async () => {
      await storage.put("dev:default", { content: "hello" });
      expect(await storage.get("dev:default")).toEqual({ content: "hello" });
    });
  });

  describe("put", () => {
    it("creates a row", async () => {
      await storage.put("tg:12345", { content: "user data" });
      expect((await storage.get("tg:12345"))?.content).toBe("user data");
    });

    it("upserts on duplicate scope", async () => {
      await storage.put("dev:default", { content: "v1" });
      await storage.put("dev:default", { content: "v2" });
      expect((await storage.get("dev:default"))?.content).toBe("v2");
      const scopes = await storage.listScopes();
      expect(scopes).toHaveLength(1);
    });
  });

  describe("patch", () => {
    it("creates from partial when no row exists", async () => {
      await storage.patch("dev:default", { content: "patched" });
      expect((await storage.get("dev:default"))?.content).toBe("patched");
    });

    it("merges with existing row using default shallow merge", async () => {
      interface Multi {
        a: string;
        b: number;
      }
      const multi = new DatabaseStorage<Multi>({
        dbPath,
        tableName: "multi_records",
        serialize: (v) => JSON.stringify(v),
        deserialize: (raw) => JSON.parse(raw),
      });
      try {
        await multi.put("dev:default", { a: "x", b: 1 });
        await multi.patch("dev:default", { b: 42 });
        expect(await multi.get("dev:default")).toEqual({ a: "x", b: 42 });
      } finally {
        multi.close();
      }
    });

    it("uses custom applyPatch when provided", async () => {
      const tmpDb = path.join(tmpRoot, "patch.db");
      const custom = new DatabaseStorage<Identity>({
        dbPath: tmpDb,
        tableName: "custom_records",
        ...identityCodec,
        applyPatch: (current, partial) => ({
          content: current.content + " | " + (partial.content ?? ""),
        }),
      });
      try {
        await custom.put("dev:default", { content: "first" });
        await custom.patch("dev:default", { content: "second" });
        expect((await custom.get("dev:default"))?.content).toBe(
          "first | second",
        );
      } finally {
        custom.close();
      }
    });
  });

  describe("delete", () => {
    it("removes the row", async () => {
      await storage.put("dev:default", { content: "hi" });
      await storage.delete("dev:default");
      expect(await storage.get("dev:default")).toBeNull();
    });

    it("is a no-op when no row exists", async () => {
      await expect(storage.delete("dev:default")).resolves.toBeUndefined();
    });
  });

  describe("listScopes", () => {
    it("returns empty when no rows", async () => {
      expect(await storage.listScopes()).toEqual([]);
    });

    it("returns all scopes sorted", async () => {
      await storage.put("tg:12345", { content: "a" });
      await storage.put("dev:default", { content: "b" });
      await storage.put("agent:jiran", { content: "c" });
      const scopes = await storage.listScopes();
      expect(scopes).toEqual(["agent:jiran", "dev:default", "tg:12345"]);
    });
  });

  describe("multi-tenant isolation", () => {
    it("different scopes do not bleed across each other", async () => {
      await storage.put("tg:user-a", { content: "a's secrets" });
      await storage.put("tg:user-b", { content: "b's secrets" });
      await storage.put("tg:user-c", { content: "c's secrets" });

      expect((await storage.get("tg:user-a"))?.content).toBe("a's secrets");
      expect((await storage.get("tg:user-b"))?.content).toBe("b's secrets");
      expect((await storage.get("tg:user-c"))?.content).toBe("c's secrets");

      // Updating one does not affect others
      await storage.put("tg:user-a", { content: "a's NEW secrets" });
      expect((await storage.get("tg:user-a"))?.content).toBe("a's NEW secrets");
      expect((await storage.get("tg:user-b"))?.content).toBe("b's secrets");
      expect((await storage.get("tg:user-c"))?.content).toBe("c's secrets");

      // Deleting one does not affect others
      await storage.delete("tg:user-b");
      expect(await storage.get("tg:user-b")).toBeNull();
      expect((await storage.get("tg:user-a"))?.content).toBe("a's NEW secrets");
      expect((await storage.get("tg:user-c"))?.content).toBe("c's secrets");
    });
  });

  describe("multiple tables in the same DB", () => {
    it("separate tables in the same DB do not interfere", async () => {
      const otherTable = new DatabaseStorage<Identity>({
        dbPath,
        tableName: "other_records",
        ...identityCodec,
      });
      try {
        await storage.put("dev:default", { content: "from test_identities" });
        await otherTable.put("dev:default", {
          content: "from other_records",
        });

        expect((await storage.get("dev:default"))?.content).toBe(
          "from test_identities",
        );
        expect((await otherTable.get("dev:default"))?.content).toBe(
          "from other_records",
        );
      } finally {
        otherTable.close();
      }
    });
  });

  describe("location", () => {
    it("returns dbPath and tableName", () => {
      expect(storage.location()).toContain(dbPath);
      expect(storage.location()).toContain("test_identities");
    });
  });

  describe("persistence across instances", () => {
    it("a new instance reads what an old instance wrote", async () => {
      await storage.put("dev:default", { content: "persisted" });
      storage.close();

      const reopened = new DatabaseStorage<Identity>({
        dbPath,
        tableName: "test_identities",
        ...identityCodec,
      });
      try {
        expect((await reopened.get("dev:default"))?.content).toBe("persisted");
      } finally {
        reopened.close();
      }
    });
  });
});
