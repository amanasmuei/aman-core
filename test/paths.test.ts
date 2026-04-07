import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import {
  getEngineDbPath,
  getAmanHome,
  ensureDir,
  scopeToPath,
} from "../src/index.js";

describe("getEngineDbPath", () => {
  const original = process.env.AMAN_ENGINE_DB;
  afterEach(() => {
    if (original === undefined) delete process.env.AMAN_ENGINE_DB;
    else process.env.AMAN_ENGINE_DB = original;
  });

  it("defaults to ~/.aman/engine.db", () => {
    delete process.env.AMAN_ENGINE_DB;
    expect(getEngineDbPath()).toBe(path.join(os.homedir(), ".aman", "engine.db"));
  });

  it("respects AMAN_ENGINE_DB env override", () => {
    process.env.AMAN_ENGINE_DB = "/tmp/custom-engine.db";
    expect(getEngineDbPath()).toBe("/tmp/custom-engine.db");
  });
});

describe("getAmanHome", () => {
  const original = process.env.AMAN_HOME;
  afterEach(() => {
    if (original === undefined) delete process.env.AMAN_HOME;
    else process.env.AMAN_HOME = original;
  });

  it("defaults to ~/.aman", () => {
    delete process.env.AMAN_HOME;
    expect(getAmanHome()).toBe(path.join(os.homedir(), ".aman"));
  });

  it("respects AMAN_HOME env override", () => {
    process.env.AMAN_HOME = "/tmp/aman-test";
    expect(getAmanHome()).toBe("/tmp/aman-test");
  });
});

describe("ensureDir", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aman-core-paths-"));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("creates a directory that doesn't exist", () => {
    const target = path.join(tmpRoot, "new");
    expect(fs.existsSync(target)).toBe(false);
    ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("creates intermediate directories", () => {
    const target = path.join(tmpRoot, "a", "b", "c");
    ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("is idempotent", () => {
    const target = path.join(tmpRoot, "x");
    ensureDir(target);
    ensureDir(target);
    ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("scopeToPath", () => {
  it("converts a 2-segment scope", () => {
    expect(scopeToPath("dev:default")).toBe(path.join("dev", "default"));
  });

  it("converts an N-segment scope", () => {
    expect(scopeToPath("tg:12345:agent:jiran")).toBe(
      path.join("tg", "12345", "agent", "jiran"),
    );
  });

  it("sanitizes disallowed characters", () => {
    expect(scopeToPath("dev:my project")).toBe(path.join("dev", "my_project"));
    expect(scopeToPath("dev:weird/path")).toBe(path.join("dev", "weird_path"));
    expect(scopeToPath("dev:has space and /")).toBe(
      path.join("dev", "has_space_and__"),
    );
  });

  it("preserves alphanumerics, dash, underscore, dot", () => {
    expect(scopeToPath("dev:my-tool_v1.2")).toBe(path.join("dev", "my-tool_v1.2"));
  });
});
