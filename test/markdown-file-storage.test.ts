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

  // ─── Scope inheritance (fallbackChain + legacyPath) ──────────────────

  describe("scope inheritance", () => {
    let inheritStorage: MarkdownFileStorage<Identity>;

    beforeEach(() => {
      // Reconfigure with dev:* -> dev:plugin fallback and a legacy path.
      // Mirrors the wiring acore-core / arules-core will use in production.
      inheritStorage = new MarkdownFileStorage<Identity>({
        root: tmpRoot,
        filename: "core.md",
        fallbackChain: (requested) =>
          requested.startsWith("dev:") && requested !== "dev:plugin"
            ? ["dev:plugin"]
            : [],
        legacyPath: path.join(tmpRoot, "core.md"),
        ...identityCodec,
      });
    });

    it("falls back from dev:copilot to dev:plugin when copilot is empty", async () => {
      // Seed only dev:plugin
      await inheritStorage.put("dev:plugin", { content: "PLUGIN_IDENTITY" });
      // Read dev:copilot — should see plugin content via fallback
      const result = await inheritStorage.get("dev:copilot");
      expect(result).toEqual({ content: "PLUGIN_IDENTITY" });
    });

    it("falls back from dev:agent to dev:plugin", async () => {
      await inheritStorage.put("dev:plugin", { content: "PLUGIN_IDENTITY" });
      const result = await inheritStorage.get("dev:agent");
      expect(result).toEqual({ content: "PLUGIN_IDENTITY" });
    });

    it("prefers own scope over the fallback chain when both exist", async () => {
      await inheritStorage.put("dev:plugin", { content: "PLUGIN" });
      await inheritStorage.put("dev:copilot", { content: "COPILOT_OWN" });
      const result = await inheritStorage.get("dev:copilot");
      expect(result).toEqual({ content: "COPILOT_OWN" });
    });

    it("dev:plugin does NOT fall back (it's the root of the chain)", async () => {
      // Put something at legacy only
      fs.writeFileSync(
        path.join(tmpRoot, "core.md"),
        "LEGACY",
        "utf-8",
      );
      // dev:plugin with empty scope should fall through to legacyPath,
      // not to some sibling scope
      const result = await inheritStorage.get("dev:plugin");
      expect(result).toEqual({ content: "LEGACY" });
    });

    it("falls back to legacyPath when chain is empty", async () => {
      fs.writeFileSync(
        path.join(tmpRoot, "core.md"),
        "LEGACY_CONTENT",
        "utf-8",
      );
      const result = await inheritStorage.get("dev:copilot");
      expect(result).toEqual({ content: "LEGACY_CONTENT" });
    });

    it("chain beats legacy (chain is checked first)", async () => {
      await inheritStorage.put("dev:plugin", { content: "PLUGIN" });
      fs.writeFileSync(
        path.join(tmpRoot, "core.md"),
        "LEGACY",
        "utf-8",
      );
      const result = await inheritStorage.get("dev:copilot");
      expect(result).toEqual({ content: "PLUGIN" });
    });

    it("returns null when nothing exists anywhere", async () => {
      const result = await inheritStorage.get("dev:copilot");
      expect(result).toBeNull();
    });

    it("writes go to the requested scope, never to a fallback target", async () => {
      await inheritStorage.put("dev:plugin", { content: "PLUGIN_ORIGINAL" });
      await inheritStorage.put("dev:copilot", { content: "COPILOT_WRITE" });

      // Own scope got the write
      expect(fs.existsSync(path.join(tmpRoot, "dev", "copilot", "core.md"))).toBe(true);
      expect(
        fs.readFileSync(path.join(tmpRoot, "dev", "copilot", "core.md"), "utf-8"),
      ).toBe("COPILOT_WRITE");

      // Fallback target was NOT clobbered
      expect(
        fs.readFileSync(path.join(tmpRoot, "dev", "plugin", "core.md"), "utf-8"),
      ).toBe("PLUGIN_ORIGINAL");
    });

    it("delete only affects the requested scope, not the fallback", async () => {
      await inheritStorage.put("dev:plugin", { content: "PLUGIN" });
      await inheritStorage.put("dev:copilot", { content: "COPILOT" });

      await inheritStorage.delete("dev:copilot");

      // copilot gone
      expect(fs.existsSync(path.join(tmpRoot, "dev", "copilot", "core.md"))).toBe(false);
      // plugin untouched
      expect(
        fs.readFileSync(path.join(tmpRoot, "dev", "plugin", "core.md"), "utf-8"),
      ).toBe("PLUGIN");

      // After delete, copilot reads fall back to plugin again
      expect(await inheritStorage.get("dev:copilot")).toEqual({ content: "PLUGIN" });
    });

    it("is cycle-safe: chain returning the requested scope is a no-op", async () => {
      const cyclicStorage = new MarkdownFileStorage<Identity>({
        root: tmpRoot,
        filename: "core.md",
        fallbackChain: (requested) => [requested, "dev:plugin"],
        ...identityCodec,
      });
      await cyclicStorage.put("dev:plugin", { content: "PLUGIN" });
      // Should not infinite loop; should find dev:plugin via the non-cyclic entry
      const result = await cyclicStorage.get("dev:copilot");
      expect(result).toEqual({ content: "PLUGIN" });
    });

    it("is cycle-safe: two chains pointing at each other", async () => {
      const cyclicStorage = new MarkdownFileStorage<Identity>({
        root: tmpRoot,
        filename: "core.md",
        fallbackChain: (requested) => {
          if (requested === "dev:a") return ["dev:b"];
          if (requested === "dev:b") return ["dev:a"];
          return [];
        },
        ...identityCodec,
      });
      // Neither exists — must return null, not loop forever
      expect(await cyclicStorage.get("dev:a")).toBeNull();
    });

    it("explainRead reports the resolution chain for diagnostics", async () => {
      await inheritStorage.put("dev:plugin", { content: "PLUGIN" });
      const diag = inheritStorage.explainRead("dev:copilot");
      expect(diag.resolved).toBe(path.join(tmpRoot, "dev", "plugin", "core.md"));
      expect(diag.triedRequested).toBe(path.join(tmpRoot, "dev", "copilot", "core.md"));
      expect(diag.triedChain).toHaveLength(1);
      expect(diag.triedChain[0]).toEqual({
        scope: "dev:plugin",
        path: path.join(tmpRoot, "dev", "plugin", "core.md"),
        exists: true,
      });
      expect(diag.triedLegacy).toEqual({
        path: path.join(tmpRoot, "core.md"),
        exists: false,
      });
    });

    it("listScopes only returns real scopes, not fallback targets", async () => {
      await inheritStorage.put("dev:plugin", { content: "PLUGIN" });
      // Don't put anything at dev:copilot — it should NOT appear in listScopes
      // just because its get() would succeed via fallback
      const scopes = await inheritStorage.listScopes();
      expect(scopes).toContain("dev:plugin");
      expect(scopes).not.toContain("dev:copilot");
    });

    it("backward compat: consumer without fallbackChain sees no fallback", async () => {
      // Default `storage` (from outer beforeEach) has no fallbackChain.
      await storage.put("dev:plugin", { content: "PLUGIN" });
      expect(await storage.get("dev:copilot")).toBeNull();
    });
  });
});
