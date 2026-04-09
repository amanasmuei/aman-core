<div align="center">

# @aman_asmuei/aman-core

**The shared substrate for the aman ecosystem.**

Multi-tenant `Scope`, generic `Storage<T>`, and `AsyncLocalStorage` propagation —
the foundation for building MCP-native AI companions that remember every user
separately, without threading scope through every function signature.

[![npm version](https://img.shields.io/npm/v/@aman_asmuei/aman-core?style=for-the-badge&logo=npm&logoColor=white&color=cb3837)](https://www.npmjs.com/package/@aman_asmuei/aman-core)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![Node ≥18](https://img.shields.io/badge/node-%E2%89%A518-brightgreen?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-74_passing-brightgreen?style=for-the-badge)](#quality-signals)
[![Part of aman](https://img.shields.io/badge/part_of-aman_ecosystem-ff6b35?style=for-the-badge)](https://github.com/amanasmuei/aman)

[Install](#install) &middot;
[Quick start](#quick-start) &middot;
[Concepts](#concepts) &middot;
[API reference](#api-reference) &middot;
[Architecture](#architecture) &middot;
[The aman ecosystem](#the-aman-ecosystem)

</div>

---

## What it is

`aman-core` is the foundation layer of the aman engine. It provides three things,
and only three things:

1. **`Scope`** — a string convention for multi-tenant addressing
2. **`Storage<T>`** — a generic interface for layer libraries to implement, plus two ready-to-use backends
3. **`withScope()`** — `AsyncLocalStorage` propagation so layer code reads scope implicitly

That's it. No business logic. No LLM clients. No MCP servers. No databases.
It is intentionally tiny, focused, and stable — every other aman layer
(`acore-core`, `arules-core`, future `aflow-core`, etc.) sits on top of it.

---

## Why it exists

The aman ecosystem is built on a single architectural bet:

> **One engine, three frontends.**
>
> The same engine code should serve a developer in Claude Code, a CLI session
> in their terminal, and thousands of Telegram users in production — with
> complete state isolation between them, and without any layer library
> needing to know which one it's running in.

That bet is impossible without a coherent, propagated, multi-tenant identity
system. `aman-core` is that identity system. Every memory, every rule,
every identity record across the aman ecosystem is keyed by a `Scope`, and
every layer call automatically picks up the active scope from
`AsyncLocalStorage` instead of threading it through every function
signature.

The result: a memory you store via the CLI shows up in Claude Code. A rule
you write for `dev:plugin` doesn't bleed into `dev:agent`. A Telegram user
at `tg:12345` and another at `tg:67890` get complete state isolation
even when their requests interleave on the same server. **Same code path,
different scope, no leakage.**

---

## Install

```bash
npm install @aman_asmuei/aman-core
```

`aman-core` has **zero runtime dependencies** by design. It uses Node's
built-in `node:async_hooks`, `node:fs`, `node:path`, and `node:os`. The only
optional dependency is `better-sqlite3` (loaded lazily, only if you use
`DatabaseStorage` or run the legacy migration helper).

---

## Quick start

```typescript
import {
  withScope,
  getCurrentScope,
  parseScope,
  formatScope,
  MarkdownFileStorage,
  DatabaseStorage,
  type Storage,
} from "@aman_asmuei/aman-core";

// 1. Hosts wrap their per-session entry points in withScope.
//    Inside, layer code reads the scope implicitly.
await withScope("tg:user-12345", async () => {
  // Anywhere in this async tree — even inside libraries you import —
  // calls to getCurrentScope() return "tg:user-12345"
  const scope = getCurrentScope(); // "tg:user-12345"

  // ... your layer libraries do their thing here
});

// 2. Two parallel sessions don't bleed across each other
await Promise.all([
  withScope("tg:alice", async () => {
    /* Alice's data only */
  }),
  withScope("tg:bob", async () => {
    /* Bob's data only */
  }),
]);

// 3. Layer libraries pick a Storage<T> backend by scope prefix
const identityStorage = new MarkdownFileStorage<Identity>({
  root: `${process.env.HOME}/.acore`,
  filename: "core.md",
  serialize: (i) => i.content,
  deserialize: (raw) => ({ content: raw }),
});

await identityStorage.put("dev:default", { content: "# Aman\n..." });
const identity = await identityStorage.get("dev:default");
// → reads ~/.acore/dev/default/core.md

await identityStorage.put("tg:user-12345", { content: "..." });
// → writes ~/.acore/tg/user-12345/core.md (different scope, different file)
```

That's the whole package, in 30 seconds.

---

## Concepts

### Scope — a colon-delimited string

A `Scope` is a string identifying *who* and *where* in the ecosystem.
The format is intentionally simple:

```
<frontend>:<id>[:<sub>...]
```

| Scope                       | Tenant       | Context              | Used by                          |
|----------------------------|--------------|----------------------|----------------------------------|
| `dev:default`              | local dev    | default              | acore CLI, single-user fallback  |
| `dev:agent`                | local dev    | aman-agent runtime   | aman-agent CLI sessions          |
| `dev:plugin`               | local dev    | Claude Code plugin   | aman-claude-code / aman-mcp           |
| `dev:cli`                  | local dev    | generic CLI          | one-off scripts                  |
| `tg:12345`                 | Telegram 12345 | (unset)            | aman-tg per-user data            |
| `agent:jiran`              | (none)       | jiran agent persona  | shared agent personality records |
| `tg:12345:agent:jiran`     | TG 12345     | jiran-for-this-user  | per-user agent customization     |

**Why a string and not a struct?** Three reasons:

1. **Backward compatibility.** `aman-tg` already uses `tg:${telegramId}` in
   production. A string format means zero migration on day one.
2. **Wire-format stability.** Strings serialize through MCP request metadata,
   HTTP headers, and database columns without any conversion.
3. **Simplicity.** Two segments handle 99% of cases. The N-segment form
   handles the rest. No nested-object validation, no schema versioning.

If you need the components, parse it:

```typescript
parseScope("tg:12345:agent:jiran");
// → {
//     frontend: "tg",
//     id: "12345",
//     parts: ["tg", "12345", "agent", "jiran"],
//     raw: "tg:12345:agent:jiran"
//   }

formatScope({ frontend: "tg", id: "12345", sub: ["agent", "jiran"] });
// → "tg:12345:agent:jiran"
```

Legacy strings (from before this convention) are normalized automatically:

```typescript
normalizeLegacyScope("global");      // → "dev:default"
normalizeLegacyScope("myproject");   // → "dev:myproject"
normalizeLegacyScope("tg:12345");    // → "tg:12345"  (already canonical)
normalizeLegacyScope(null);          // → "dev:default"
```

### withScope — AsyncLocalStorage propagation

The killer feature. Hosts wrap their per-session entry points once, and every
layer call inside reads the scope implicitly — no parameter threading.

```typescript
import { withScope, getCurrentScope } from "@aman_asmuei/aman-core";

// In aman-claude-code (Claude Code host):
await withScope("dev:plugin", async () => {
  // Every call inside here sees scope = "dev:plugin"
  await amem.recall("what do i know about pnpm");
  await acore.getIdentity();
  await arules.checkAction("rm -rf /");
});

// In aman-tg backend (Telegram bot):
bot.on("message", async (ctx) => {
  const scope = `tg:${ctx.from.id}`;
  await withScope(scope, async () => {
    // Jiran sees ONLY this user's memories, identity, and rules
    const reply = await jiran.chat(ctx.message.text);
    await ctx.reply(reply);
  });
});
```

Scope propagates correctly across:
- `await` boundaries (`Promise.all`, `setTimeout`, callbacks)
- Nested `withScope()` blocks (inner overrides outer, outer restores after)
- Concurrent sessions (two `withScope()` calls in parallel never bleed)

If you call `getCurrentScope()` outside any `withScope` block, it throws.
Use `getCurrentScopeOr(fallback)` if you want a default instead.

### Storage&lt;T&gt; — the generic interface

Every layer library implements its records via this interface, parameterized
by its own record type:

```typescript
interface Storage<T> {
  get(scope: Scope): Promise<T | null>;
  put(scope: Scope, value: T): Promise<void>;
  patch(scope: Scope, partial: Partial<T>): Promise<void>;
  delete(scope: Scope): Promise<void>;
  listScopes(): Promise<Scope[]>;
}
```

Two production-ready backends ship with `aman-core`:

| Backend                  | Best for                          | Where it persists                                 |
|-------------------------|-----------------------------------|---------------------------------------------------|
| `MarkdownFileStorage<T>` | Dev-side (`dev:*`) — human-edited | `{root}/{scopeToPath(scope)}/{filename}` on disk  |
| `DatabaseStorage<T>`     | Server / multi-tenant — programmatic | SQLite (or Postgres later) table keyed by scope |

Both implement the same `Storage<T>` interface. Layer libraries pick at runtime:

```typescript
function getStorageForScope(scope: string): Storage<Identity> {
  return parseScope(scope).frontend === "dev"
    ? markdownStorage   // human-editable
    : databaseStorage;  // multi-tenant
}
```

That's the *whole* multi-tenant story. Pick by prefix, store by scope.

---

## API reference

### Scope helpers

| Symbol                          | Type        | Purpose                                          |
|--------------------------------|-------------|--------------------------------------------------|
| `Scope`                        | type alias  | `= string` — colon-delimited, e.g. `tg:12345`   |
| `ParsedScope`                  | interface   | `{frontend, id, parts, raw}`                    |
| `parseScope(scope)`            | function    | Parse a scope into its components               |
| `formatScope({frontend, id})`  | function    | Build a scope from components                   |
| `normalizeLegacyScope(s)`      | function    | Convert pre-tenancy strings to canonical form   |

### AsyncLocalStorage propagation

| Symbol                          | Returns     | Purpose                                          |
|--------------------------------|-------------|--------------------------------------------------|
| `withScope(scope, fn)`         | `T`         | Run `fn` with `scope` active in the async tree  |
| `getCurrentScope()`            | `Scope`     | Read active scope; throws if none               |
| `getCurrentScopeOr(fallback)`  | `Scope`     | Read active scope or return fallback            |
| `hasActiveScope()`             | `boolean`   | True if a `withScope` block is currently active |

### Storage&lt;T&gt; backends

| Symbol                         | Purpose                                                        |
|-------------------------------|----------------------------------------------------------------|
| `Storage<T>`                  | The generic interface — `get/put/patch/delete/listScopes`     |
| `StorageWithLocation`         | Optional tag interface for backends that expose `.location()` |
| `MarkdownFileStorage<T>`      | One file per scope, human-editable, git-versionable            |
| `DatabaseStorage<T>`          | One row per scope in a SQLite table; lazy `better-sqlite3`     |

### Path helpers

| Symbol                          | Returns     | Purpose                                          |
|--------------------------------|-------------|--------------------------------------------------|
| `getEngineDbPath()`            | `string`    | `~/.aman/engine.db` (or `$AMAN_ENGINE_DB`)       |
| `getAmanHome()`                | `string`    | `~/.aman` (or `$AMAN_HOME`)                      |
| `ensureDir(path)`              | `void`      | Idempotent recursive `mkdir`                    |
| `scopeToPath(scope)`           | `string`    | `tg:12345:agent:jiran` → `tg/12345/agent/jiran` |

### Migration

| Symbol                          | Purpose                                                        |
|--------------------------------|----------------------------------------------------------------|
| `migrateLegacyAmemDb(opts?)`   | One-time copy of `~/.amem/memory.db` → `~/.aman/engine.db` with legacy scopes rewritten |

The migration is idempotent and never deletes the legacy file.

---

## Architecture

```
                  ┌─────────────────────────────────────┐
                  │   aman engine v1 — 4 layer libs     │
                  │                                     │
                  │   acore-core    arules-core         │
                  │   amem-core     (future layers)     │
                  │       │              │              │
                  │       └──────┬───────┘              │
                  │              │                      │
                  │              ▼                      │
                  │   ┌─────────────────────┐           │
                  │   │   aman-core         │ ← YOU     │
                  │   │   (this package)    │  ARE      │
                  │   │                     │  HERE     │
                  │   │  Scope              │           │
                  │   │  Storage<T>         │           │
                  │   │  withScope          │           │
                  │   │  paths + migrate    │           │
                  │   └─────────────────────┘           │
                  └─────────────────────────────────────┘
                              ▲
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ aman-claude-code │    │    aman-agent    │    │     aman-tg      │
│   Claude Code    │    │    CLI runtime   │    │     Telegram     │
│                  │    │                  │    │    super-app     │
│     scope=       │    │      scope=      │    │      scope=      │
│    dev:plugin    │    │    dev:agent     │    │    tg:userId     │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

`aman-core` is the foundation. The four layer libraries (`acore-core`,
`arules-core`, `amem-core`, future ones) consume it to build their
multi-tenant features. The three frontends (Claude Code via `aman-claude-code`,
CLI via `aman-agent`, Telegram via `aman-tg`) all run on the same engine
through this single substrate.

**A bug fix in `aman-core` propagates to every layer and every frontend
simultaneously.** That's the win condition.

---

## What this is NOT

To stay tiny and stable, `aman-core` deliberately does not provide:

- **A database.** It defines the storage *interface*; concrete backends
  for layers' record types live in those layers (or use the two backends
  shipped here).
- **An LLM client.** That's the runtime's job (`aman-agent`, the `aman-tg`
  backend).
- **An MCP server.** That's `aman-mcp`.
- **Identity, rules, or memory.** Those are separate layer libraries
  (`acore-core`, `arules-core`, `amem-core`).
- **A configuration system.** Layers configure themselves via env vars and
  constructor options.

If you're looking for the "full aman experience," install the layer
libraries and a frontend. This package is the substrate they share.

---

## Quality signals

- **74 unit tests, all passing**, across 5 test files:
  - `scope.test.ts` — 23 tests covering parse/format/normalize and AsyncLocalStorage propagation including parallel-no-bleed
  - `paths.test.ts` — 11 tests covering env overrides and `scopeToPath` sanitization
  - `migrate.test.ts` — 5 integration tests with a real SQLite database
  - `markdown-file-storage.test.ts` — 16 tests covering get/put/patch/delete/listScopes and isolation
  - `database-storage.test.ts` — 19 tests covering the same plus table-name SQL-injection rejection
- **`tsc --noEmit` clean** with `strict`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`
- **ESM only**, Node ≥18, TypeScript declarations + sourcemaps included
- **Zero runtime dependencies.** Optional `better-sqlite3` loaded lazily.

---

## The aman ecosystem

`aman-core` is one of several packages in the aman AI companion ecosystem:

| Layer                                                                   | Role                                                |
|------------------------------------------------------------------------|-----------------------------------------------------|
| **[@aman_asmuei/aman-core](https://github.com/amanasmuei/aman-core)**   | **Substrate** — Scope, Storage, withScope (this)    |
| [@aman_asmuei/acore-core](https://github.com/amanasmuei/acore-core)     | Identity layer — multi-tenant Identity records      |
| [@aman_asmuei/arules-core](https://github.com/amanasmuei/arules-core)   | Guardrails layer — rule parsing and runtime checks  |
| [@aman_asmuei/amem-core](https://github.com/amanasmuei/amem)            | Memory layer — semantic recall, embeddings          |
| [@aman_asmuei/aman-mcp](https://github.com/amanasmuei/aman-mcp)         | MCP server aggregating all layers for any host      |
| [@aman_asmuei/aman-agent](https://github.com/amanasmuei/aman-agent)     | Standalone CLI runtime, multi-LLM, scope-aware      |
| [aman-claude-code](https://github.com/amanasmuei/aman-claude-code)                | Claude Code plugin (hooks + skills + MCP installer) |
| [@aman_asmuei/aman](https://github.com/amanasmuei/aman)                 | Umbrella installer — one command for the ecosystem  |

---

## License

[MIT](LICENSE) © Aman Asmuei

---

<div align="center">
  <sub>Built with ❤️ in 🇲🇾 <strong>Malaysia</strong> · Part of the <a href="https://github.com/amanasmuei">aman ecosystem</a></sub>
</div>
