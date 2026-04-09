import * as fs from "node:fs";
import * as path from "node:path";
import type { Scope } from "./scope.js";
import type { Storage, StorageWithLocation } from "./storage.js";
import { ensureDir, scopeToPath } from "./paths.js";

/**
 * Configuration for a MarkdownFileStorage instance.
 *
 * Each scope's record lives at `{root}/{scopeToPath(scope)}/{filename}`.
 * For example, with `root: "~/.acore"`, `filename: "core.md"`:
 *
 *   scope "dev:default"           → ~/.acore/dev/default/core.md
 *   scope "tg:12345:agent:jiran"  → ~/.acore/tg/12345/agent/jiran/core.md
 *
 * Layers are responsible for serialize/deserialize between the typed record
 * T and the markdown string that lives on disk. The simplest case is
 * `T = { content: string }` with identity serializers — that lets the layer
 * own the markdown structure entirely.
 */
export interface MarkdownFileStorageOptions<T> {
  /**
   * Root directory for the layer's files. e.g. `~/.acore`, `~/.arules`.
   */
  root: string;

  /**
   * Filename within each scope's directory. e.g. `"core.md"`, `"rules.md"`.
   */
  filename: string;

  /**
   * Convert a typed record T to the markdown string written to disk.
   */
  serialize: (value: T) => string;

  /**
   * Parse a markdown string from disk back into a typed record T.
   */
  deserialize: (markdown: string) => T;

  /**
   * Custom patch logic. If omitted, `patch` defaults to a shallow object
   * merge: `{ ...current, ...partial }`. Override this when the record has
   * structural fields (e.g. markdown sections) that need surgical updates.
   */
  applyPatch?: (current: T, partial: Partial<T>) => T;

  /**
   * Optional read-only scope inheritance. When `get(scope)` finds no file
   * at the requested scope, it tries each scope returned by this function
   * in order, returning the first hit. Writes (`put`, `patch`, `delete`)
   * always target the requested scope — inheritance is read-only.
   *
   * Use case: a user sets up identity via aman-plugin (writes to
   * `dev:plugin`), then installs aman-copilot (`dev:copilot` scope) or
   * aman-agent (`dev:agent` scope). Those new surfaces should read the
   * same identity without re-entry. The consuming library declares the
   * inheritance policy:
   *
   *   new MarkdownFileStorage({
   *     ...
   *     fallbackChain: (requested) =>
   *       requested.startsWith("dev:") && requested !== "dev:plugin"
   *         ? ["dev:plugin"]
   *         : [],
   *   });
   *
   * If omitted, no fallback occurs (current behavior — fully scope-local).
   */
  fallbackChain?: (requested: Scope) => Scope[];

  /**
   * Optional absolute path to a flat-layout legacy file, checked as the
   * final read fallback after `fallbackChain`. For migration compatibility
   * with pre-engine-v1 single-tenant layouts like `~/.acore/core.md`.
   *
   * Like `fallbackChain`, this is read-only — writes always go to the
   * requested scope's proper path.
   *
   * If omitted, no legacy fallback occurs.
   */
  legacyPath?: string;
}

/**
 * A `Storage<T>` backend that persists records as markdown files on disk.
 *
 * Use this for dev-side scopes (`dev:*`) where human-editable, git-versionable
 * files are a feature. Use `DatabaseStorage<T>` for high-volume server scopes
 * (`tg:*`, `agent:*`).
 *
 * This class is intentionally simple: synchronous fs underneath, async API on
 * top. Concurrency safety is "last writer wins" — if your layer needs stronger
 * guarantees, use `DatabaseStorage<T>` or wrap calls in your own mutex.
 */
export class MarkdownFileStorage<T>
  implements Storage<T>, StorageWithLocation
{
  constructor(private readonly opts: MarkdownFileStorageOptions<T>) {}

  async get(scope: Scope): Promise<T | null> {
    const filePath = this.resolveReadPath(scope);
    if (filePath === null) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return this.opts.deserialize(raw);
  }

  /**
   * Resolve the file path to READ for a given scope, honoring the
   * fallbackChain and legacyPath inheritance rules. Returns null if
   * nothing exists anywhere in the chain.
   *
   * Algorithm:
   *   1. Try the requested scope's direct path.
   *   2. For each scope in fallbackChain(requested), try its direct path.
   *   3. Try legacyPath (if configured).
   *   4. Return null.
   *
   * Cycle protection: a scope visited once is never visited again, so a
   * fallbackChain that accidentally returns the requested scope (or loops)
   * is safe.
   */
  private resolveReadPath(scope: Scope): string | null {
    // Guard against chain cycles.
    const visited = new Set<Scope>();

    const tryScope = (s: Scope): string | null => {
      if (visited.has(s)) return null;
      visited.add(s);
      const p = this.pathFor(s);
      return fs.existsSync(p) ? p : null;
    };

    // 1. Direct hit on the requested scope.
    const direct = tryScope(scope);
    if (direct) return direct;

    // 2. Walk the fallback chain (read-only inheritance).
    if (this.opts.fallbackChain) {
      const chain = this.opts.fallbackChain(scope);
      for (const fallback of chain) {
        const hit = tryScope(fallback);
        if (hit) return hit;
      }
    }

    // 3. Legacy flat-layout fallback.
    if (this.opts.legacyPath && fs.existsSync(this.opts.legacyPath)) {
      return this.opts.legacyPath;
    }

    return null;
  }

  /**
   * Return diagnostic info about how `get(scope)` would resolve a read.
   * Useful for debugging "why is my identity empty?" scenarios.
   */
  explainRead(scope: Scope): {
    resolved: string | null;
    triedRequested: string;
    triedChain: Array<{ scope: Scope; path: string; exists: boolean }>;
    triedLegacy: { path: string; exists: boolean } | null;
  } {
    const triedRequested = this.pathFor(scope);
    const triedChain: Array<{ scope: Scope; path: string; exists: boolean }> = [];
    if (this.opts.fallbackChain) {
      for (const s of this.opts.fallbackChain(scope)) {
        triedChain.push({
          scope: s,
          path: this.pathFor(s),
          exists: fs.existsSync(this.pathFor(s)),
        });
      }
    }
    const triedLegacy = this.opts.legacyPath
      ? { path: this.opts.legacyPath, exists: fs.existsSync(this.opts.legacyPath) }
      : null;
    return {
      resolved: this.resolveReadPath(scope),
      triedRequested,
      triedChain,
      triedLegacy,
    };
  }

  async put(scope: Scope, value: T): Promise<void> {
    const filePath = this.pathFor(scope);
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, this.opts.serialize(value), "utf-8");
  }

  async patch(scope: Scope, partial: Partial<T>): Promise<void> {
    const current = await this.get(scope);
    let merged: T;
    if (current === null) {
      // No existing record — treat partial as the full new record. Layers
      // that want strict "patch only" semantics can override `applyPatch`
      // to throw, or check existence first.
      merged = partial as T;
    } else if (this.opts.applyPatch) {
      merged = this.opts.applyPatch(current, partial);
    } else {
      // Default: shallow merge for object-shaped records
      merged = { ...(current as object), ...(partial as object) } as T;
    }
    await this.put(scope, merged);
  }

  async delete(scope: Scope): Promise<void> {
    const filePath = this.pathFor(scope);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  async listScopes(): Promise<Scope[]> {
    if (!fs.existsSync(this.opts.root)) return [];
    const scopes: Scope[] = [];
    this.walkDir(this.opts.root, [], scopes);
    return scopes;
  }

  /**
   * Resolve the on-disk file path for a scope. Useful for diagnostics and tests.
   */
  pathFor(scope: Scope): string {
    return path.join(
      this.opts.root,
      scopeToPath(scope),
      this.opts.filename,
    );
  }

  location(): string {
    return this.opts.root;
  }

  private walkDir(dir: string, prefix: string[], out: Scope[]): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(fullPath, [...prefix, entry.name], out);
      } else if (entry.isFile() && entry.name === this.opts.filename) {
        // A scope must have at least 2 segments (frontend:id). Files at the
        // root or 1 level deep are ignored — they don't correspond to a scope.
        if (prefix.length >= 2) {
          out.push(prefix.join(":"));
        }
      }
    }
  }
}
