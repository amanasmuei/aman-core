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
    const filePath = this.pathFor(scope);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return this.opts.deserialize(raw);
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
