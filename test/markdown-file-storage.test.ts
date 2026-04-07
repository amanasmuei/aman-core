import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { MarkdownFileStorage } from "../src/index.js";

interface Identity {
  content: string;
}

const identityCodec = {
  serialize: (v: Identity) => v.content,
  deserialize: (raw: string): Identity => ({ content: raw }),
};

describe("MarkdownFileStorage", () => {
  let tmpRoot: string;
  let storage: MarkdownFileStorage<Identity>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aman-mfs-"));
    storage = new MarkdownFileStorage<Identity>({
      root: tmpRoot,
      filename: "core.md",
      ...identityCodec,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe("get", () => {
    it("returns null when no file exists", async () => {
      expect(await storage.get("dev:default")).toBeNull();
    });

    it("returns parsed record after put", async () => {
      await storage.put("dev:default", { content: "# Aman\nThe builder." });
      const result = await storage.get("dev:default");
      expect(result).toEqual({ content: "# Aman\nThe builder." });
    });
  });

  describe("put", () => {
    it("writes to {root}/{scopeToPath}/{filename}", async () => {
      await storage.put("dev:default", { content: "hello" });
      const expectedPath = path.join(tmpRoot, "dev", "default", "core.md");
      expect(fs.existsSync(expectedPath)).toBe(true);
      expect(fs.readFileSync(expectedPath, "utf-8")).toBe("hello");
    });

    it("creates intermediate directories", async () => {
      await storage.put("tg:12345:agent:jiran", { content: "jiran content" });
      const expectedPath = path.join(
        tmpRoot,
        "tg",
        "12345",
        "agent",
        "jiran",
        "core.md",
      );
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    it("overwrites existing content", async () => {
      await storage.put("dev:default", { content: "v1" });
      await storage.put("dev:default", { content: "v2" });
      const result = await storage.get("dev:default");
      expect(result?.content).toBe("v2");
    });
  });

  describe("patch", () => {
    it("creates a record from partial when none exists", async () => {
      await storage.patch("dev:default", { content: "from patch" });
      const result = await storage.get("dev:default");
      expect(result?.content).toBe("from patch");
    });

    it("uses default shallow merge when no applyPatch is provided", async () => {
      interface Multi {
        a: string;
        b: number;
      }
      const multiStorage = new MarkdownFileStorage<Multi>({
        root: tmpRoot,
        filename: "multi.md",
        serialize: (v) => JSON.stringify(v),
        deserialize: (raw) => JSON.parse(raw),
      });
      await multiStorage.put("dev:default", { a: "x", b: 1 });
      await multiStorage.patch("dev:default", { b: 99 });
      const result = await multiStorage.get("dev:default");
      expect(result).toEqual({ a: "x", b: 99 });
    });

    it("uses custom applyPatch when provided", async () => {
      const customStorage = new MarkdownFileStorage<Identity>({
        root: tmpRoot,
        filename: "custom.md",
        ...identityCodec,
        applyPatch: (current, partial) => ({
          content: current.content + "\n\n[PATCH]: " + (partial.content ?? ""),
        }),
      });
      await customStorage.put("dev:default", { content: "original" });
      await customStorage.patch("dev:default", { content: "addendum" });
      const result = await customStorage.get("dev:default");
      expect(result?.content).toBe("original\n\n[PATCH]: addendum");
    });
  });

  describe("delete", () => {
    it("removes the file for a scope", async () => {
      await storage.put("dev:default", { content: "hello" });
      await storage.delete("dev:default");
      expect(await storage.get("dev:default")).toBeNull();
    });

    it("is a no-op when no file exists", async () => {
      await expect(storage.delete("dev:default")).resolves.toBeUndefined();
    });
  });

  describe("listScopes", () => {
    it("returns empty when root does not exist", async () => {
      const fresh = new MarkdownFileStorage<Identity>({
        root: path.join(tmpRoot, "does-not-exist"),
        filename: "core.md",
        ...identityCodec,
      });
      expect(await fresh.listScopes()).toEqual([]);
    });

    it("finds all scopes recursively", async () => {
      await storage.put("dev:default", { content: "a" });
      await storage.put("dev:agent", { content: "b" });
      await storage.put("tg:12345", { content: "c" });
      await storage.put("tg:12345:agent:jiran", { content: "d" });
      const scopes = await storage.listScopes();
      expect(scopes.sort()).toEqual(
        [
          "dev:default",
          "dev:agent",
          "tg:12345",
          "tg:12345:agent:jiran",
        ].sort(),
      );
    });

    it("ignores files that don't match the configured filename", async () => {
      await storage.put("dev:default", { content: "ok" });
      // Drop a stray file at the same depth
      fs.writeFileSync(
        path.join(tmpRoot, "dev", "default", "other.md"),
        "ignored",
        "utf-8",
      );
      const scopes = await storage.listScopes();
      expect(scopes).toEqual(["dev:default"]);
    });
  });

  describe("isolation between scopes", () => {
    it("does not let one scope read another's content", async () => {
      await storage.put("tg:user-a", { content: "a's secrets" });
      await storage.put("tg:user-b", { content: "b's secrets" });
      expect((await storage.get("tg:user-a"))?.content).toBe("a's secrets");
      expect((await storage.get("tg:user-b"))?.content).toBe("b's secrets");
    });
  });

  describe("pathFor and location", () => {
    it("pathFor returns the correct path", () => {
      expect(storage.pathFor("dev:default")).toBe(
        path.join(tmpRoot, "dev", "default", "core.md"),
      );
    });

    it("location returns the root", () => {
      expect(storage.location()).toBe(tmpRoot);
    });
  });
});
