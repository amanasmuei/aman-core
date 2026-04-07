import type { Scope } from "./scope.js";

/**
 * Generic storage interface for layer libraries (acore-core, arules-core, ...).
 *
 * Each layer defines its own record type T and either picks one of the
 * standard backends (MarkdownFileStorage, DatabaseStorage — both shipped in
 * aman-core) or implements its own.
 *
 * Scope is the multi-tenant key. Every operation is scoped — there is no
 * implicit "default scope" at this layer. Layer libraries that want to read
 * the active scope from AsyncLocalStorage should call `getCurrentScope()`
 * before invoking storage methods.
 *
 * Convention: implementations should be safe to call concurrently from the
 * same process, but no atomicity is guaranteed across put/patch unless the
 * implementation says so.
 */
export interface Storage<T> {
  /**
   * Get the record at the given scope, or null if it doesn't exist.
   */
  get(scope: Scope): Promise<T | null>;

  /**
   * Replace the entire record at the given scope. Creates if missing.
   */
  put(scope: Scope, value: T): Promise<void>;

  /**
   * Apply a partial update to the record at the given scope.
   *
   * Default behavior (implementations may override):
   *   - if no record exists, create one from `partial` (treat as upsert)
   *   - if a record exists, shallow-merge `partial` into it and persist
   *
   * Implementations that need deep merge or patch semantics (e.g. markdown
   * section replacement) document the behavior in their own JSDoc.
   */
  patch(scope: Scope, partial: Partial<T>): Promise<void>;

  /**
   * Remove the record at the given scope. No-op if it doesn't exist.
   */
  delete(scope: Scope): Promise<void>;

  /**
   * List all known scopes for this storage. Used by admin tooling and
   * migration scripts, not by hot recall paths.
   */
  listScopes(): Promise<Scope[]>;
}

/**
 * Tag interface for storage backends that can be probed for their underlying
 * physical location (file path, DB path, table name, etc). Optional —
 * implementations don't have to provide it.
 */
export interface StorageWithLocation {
  /** Human-readable description of where this storage persists data. */
  location(): string;
}
