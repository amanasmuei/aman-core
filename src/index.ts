// ── Scope ────────────────────────────────────────────────────────────────────
export {
  type Scope,
  type ParsedScope,
  parseScope,
  formatScope,
  normalizeLegacyScope,
  withScope,
  getCurrentScope,
  getCurrentScopeOr,
  hasActiveScope,
} from "./scope.js";

// ── Storage interface ────────────────────────────────────────────────────────
export {
  type Storage,
  type StorageWithLocation,
} from "./storage.js";

// ── Storage backends ─────────────────────────────────────────────────────────
export {
  MarkdownFileStorage,
  type MarkdownFileStorageOptions,
} from "./markdown-file-storage.js";

export {
  DatabaseStorage,
  type DatabaseStorageOptions,
} from "./database-storage.js";

// ── Paths ────────────────────────────────────────────────────────────────────
export {
  getEngineDbPath,
  getAmanHome,
  ensureDir,
  scopeToPath,
} from "./paths.js";

// ── Migration ────────────────────────────────────────────────────────────────
export {
  type MigrationReport,
  type MigrationOptions,
  migrateLegacyAmemDb,
} from "./migrate.js";
