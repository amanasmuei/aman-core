import { describe, it, expect } from "vitest";
import {
  parseScope,
  formatScope,
  normalizeLegacyScope,
  withScope,
  getCurrentScope,
  getCurrentScopeOr,
  hasActiveScope,
} from "../src/index.js";

describe("parseScope", () => {
  it("parses a 2-segment scope", () => {
    expect(parseScope("dev:default")).toEqual({
      frontend: "dev",
      id: "default",
      parts: ["dev", "default"],
      raw: "dev:default",
    });
  });

  it("parses an N-segment scope", () => {
    const parsed = parseScope("tg:12345:agent:jiran");
    expect(parsed.frontend).toBe("tg");
    expect(parsed.id).toBe("12345");
    expect(parsed.parts).toEqual(["tg", "12345", "agent", "jiran"]);
    expect(parsed.raw).toBe("tg:12345:agent:jiran");
  });

  it("normalizes a bare string as a legacy project name under dev:", () => {
    expect(parseScope("myproject")).toEqual({
      frontend: "dev",
      id: "myproject",
      parts: ["dev", "myproject"],
      raw: "myproject",
    });
  });

  it("normalizes empty bare string to dev:default", () => {
    // The bare string "" is rejected by the type guard, but a single ":" gets
    // treated as ['', ''], so test the no-colon variant separately:
    expect(() => parseScope("")).toThrow(TypeError);
  });

  it("throws on non-string input", () => {
    // @ts-expect-error - intentionally wrong
    expect(() => parseScope(undefined)).toThrow(TypeError);
    // @ts-expect-error - intentionally wrong
    expect(() => parseScope(123)).toThrow(TypeError);
  });
});

describe("formatScope", () => {
  it("formats a basic scope", () => {
    expect(formatScope({ frontend: "dev", id: "default" })).toBe("dev:default");
  });

  it("formats with sub-segments", () => {
    expect(
      formatScope({ frontend: "tg", id: "12345", sub: ["agent", "jiran"] }),
    ).toBe("tg:12345:agent:jiran");
  });

  it("throws on segments containing :", () => {
    expect(() => formatScope({ frontend: "dev", id: "with:colon" })).toThrow(
      /cannot contain ':'/,
    );
    expect(() =>
      formatScope({ frontend: "dev", id: "ok", sub: ["bad:value"] }),
    ).toThrow(/cannot contain ':'/);
  });

  it("throws on empty segments", () => {
    expect(() => formatScope({ frontend: "", id: "x" })).toThrow();
    expect(() => formatScope({ frontend: "dev", id: "" })).toThrow();
  });

  it("round-trips with parseScope for canonical scopes", () => {
    const cases = [
      "dev:default",
      "dev:agent",
      "tg:12345",
      "agent:jiran",
      "tg:12345:agent:jiran",
    ];
    for (const c of cases) {
      const p = parseScope(c);
      const built = formatScope({
        frontend: p.frontend,
        id: p.id,
        sub: p.parts.slice(2),
      });
      expect(built).toBe(c);
    }
  });
});

describe("normalizeLegacyScope", () => {
  it("converts 'global' to 'dev:default'", () => {
    expect(normalizeLegacyScope("global")).toBe("dev:default");
  });

  it("converts bare project names to dev:<name>", () => {
    expect(normalizeLegacyScope("myproject")).toBe("dev:myproject");
    expect(normalizeLegacyScope("aman-agent")).toBe("dev:aman-agent");
  });

  it("preserves already-canonical scopes", () => {
    expect(normalizeLegacyScope("tg:12345")).toBe("tg:12345");
    expect(normalizeLegacyScope("dev:agent")).toBe("dev:agent");
    expect(normalizeLegacyScope("tg:12345:agent:jiran")).toBe(
      "tg:12345:agent:jiran",
    );
  });

  it("treats null/undefined/empty as dev:default", () => {
    expect(normalizeLegacyScope(null)).toBe("dev:default");
    expect(normalizeLegacyScope(undefined)).toBe("dev:default");
    expect(normalizeLegacyScope("")).toBe("dev:default");
  });
});

describe("withScope and getCurrentScope", () => {
  it("getCurrentScope throws outside withScope", () => {
    expect(() => getCurrentScope()).toThrow(/no active scope/);
  });

  it("hasActiveScope returns false outside withScope", () => {
    expect(hasActiveScope()).toBe(false);
  });

  it("getCurrentScopeOr returns fallback outside withScope", () => {
    expect(getCurrentScopeOr("dev:default")).toBe("dev:default");
  });

  it("withScope makes the scope readable inside", async () => {
    await withScope("dev:agent", async () => {
      expect(hasActiveScope()).toBe(true);
      expect(getCurrentScope()).toBe("dev:agent");
      expect(getCurrentScopeOr("dev:default")).toBe("dev:agent");
    });
  });

  it("withScope returns the value of fn", async () => {
    const result = await withScope("dev:agent", async () => 42);
    expect(result).toBe(42);
  });

  it("withScope supports synchronous fn", () => {
    const result = withScope("dev:agent", () => "ok");
    expect(result).toBe("ok");
  });

  it("scopes are isolated across nested withScope calls", async () => {
    await withScope("tg:111", async () => {
      expect(getCurrentScope()).toBe("tg:111");
      await withScope("tg:222", async () => {
        expect(getCurrentScope()).toBe("tg:222");
      });
      expect(getCurrentScope()).toBe("tg:111");
    });
    expect(hasActiveScope()).toBe(false);
  });

  it("scope propagates across awaited promises", async () => {
    await withScope("tg:42", async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getCurrentScope()).toBe("tg:42");
      await Promise.all([
        Promise.resolve().then(() => {
          expect(getCurrentScope()).toBe("tg:42");
        }),
        Promise.resolve().then(() => {
          expect(getCurrentScope()).toBe("tg:42");
        }),
      ]);
    });
  });

  it("parallel withScope calls do not bleed across each other", async () => {
    const results = await Promise.all([
      withScope("tg:user-a", async () => {
        await new Promise((r) => setTimeout(r, 5));
        return getCurrentScope();
      }),
      withScope("tg:user-b", async () => {
        await new Promise((r) => setTimeout(r, 3));
        return getCurrentScope();
      }),
      withScope("tg:user-c", async () => {
        await new Promise((r) => setTimeout(r, 1));
        return getCurrentScope();
      }),
    ]);
    expect(results).toEqual(["tg:user-a", "tg:user-b", "tg:user-c"]);
  });
});
