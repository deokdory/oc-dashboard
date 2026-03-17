# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-17
**Commit:** 794fcb9
**Branch:** fix/subagent-stale-list

## OVERVIEW

Real-time OpenCode session monitoring dashboard. Bun single-server (TypeScript + SQLite) with SSE push to a vanilla SPA frontend. Zero external framework dependencies.

## STRUCTURE

```
oc-dashboard/
├── server.ts      # HTTP server, SSE broadcast, state aggregation, demo mode
├── db.ts          # All SQLite queries — readonly access to OpenCode's DB
├── process.ts     # macOS-only process detection (ps aux + lsof)
├── plugin/        # OpenCode plugin — writes active-sessions.json on session events
│   └── index.ts
├── public/
│   └── index.html # Entire frontend: HTML + CSS + JS in single file (1209 lines)
├── tests/
│   ├── helpers.ts      # Test DB factory (in-memory + file-based)
│   ├── db.test.ts      # DB layer unit tests (490 lines)
│   ├── server.test.ts  # HTTP endpoint tests
│   └── e2e.test.ts     # Playwright browser tests
└── data.db        # Local SQLite (gitignored, not OpenCode's DB)
```

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Add new data source | `db.ts` | Follow `batchGet*` pattern with `openDb()` per call |
| New API endpoint | `server.ts` → `Bun.serve.fetch()` | URL routing is manual string matching |
| Frontend changes | `public/index.html` | Single-file SPA, all JS inline in `<script>` |
| Session status logic | `server.ts` → `buildState()` | Merges plugin file + process detection + DB |
| Status classification | `db.ts` → `classifyStatus()` | ACTIVE <10s, RECENT <5min, IDLE >5min |
| Plugin behavior | `plugin/index.ts` | Writes `~/.local/share/opencode/active-sessions.json` |
| Process detection | `process.ts` | macOS-only: `ps aux` → filter `opencode` → `lsof` for cwd |
| Test setup | `tests/helpers.ts` | `createTestDbFile()` returns tmp DB + cleanup fn |
| Demo mode | `server.ts` → `buildDemoState()` | `DEMO=true bun run server.ts` for mock data |

## CONVENTIONS

- **DB access**: Open → query → close per function call. No connection pooling. Always `readonly: true`.
- **Batch queries**: `batchGet*(sessionIds: string[])` with `IN (${placeholders})` pattern. Return `Record<string, T>`.
- **Error handling**: `try/catch` → `console.warn("[module]", err)` → return empty default (never throw to caller).
- **Types**: Interfaces exported from `db.ts`. DB columns are `snake_case`, TS properties are `camelCase`.
- **Frontend**: No build step, no framework. Raw DOM manipulation. SSE via `EventSource`. All in one HTML file.
- **Naming**: Files are `kebab-case.ts`. Korean commit messages. Types use `interface` (not `type`).
- **Tests**: `bun:test` with `describe/test/expect`. DB tests override `process.env.DB_PATH` with temp file.

## ANTI-PATTERNS (THIS PROJECT)

- **NEVER** use connection pooling or keep DB handles open — `openDb()` per function is intentional (OpenCode's DB is shared)
- **NEVER** add frontend build tooling (webpack, vite, etc.) — zero-dependency SPA is a design choice
- **NEVER** add npm dependencies to root `package.json` unless absolutely unavoidable (playwright is for tests only)
- **NEVER** assume Linux — process detection uses macOS-specific `lsof -p PID -a -d cwd -Fn`
- **NEVER** write to OpenCode's DB — all DB access is `readonly: true`
- **NEVER** use `as any` or `@ts-ignore` — strict mode is enforced
- **AVOID** splitting `public/index.html` — the single-file approach is deliberate for zero-build deployment

## UNIQUE STYLES

- **Plugin architecture**: Symlinked into `~/.config/opencode/plugins/`. Communicates via JSON file, not IPC.
- **Dual detection**: Session activity detected via plugin file (primary) OR process detection (fallback).
- **Dismiss pattern**: In-memory `Set<string>` for dismissed sessions — not persisted, resets on restart.
- **Caching**: `projectsCache` with 30s TTL. Sessions are always fresh.
- **SSE**: 2s polling interval. Broadcast skipped when `clients.size === 0`.
- **Demo mode**: `DEMO=true` env var serves hardcoded mock data — useful for development without OpenCode running.

## COMMANDS

```bash
# Dev
bun run server.ts                    # Start server (port 3333)
PORT=8080 bun run server.ts          # Custom port
DEMO=true bun run server.ts          # Demo mode with mock data
DB_PATH=/path/to/db bun run server.ts  # Custom OpenCode DB path

# Test
bun test                             # All tests
bun test tests/db.test.ts            # DB tests only

# Plugin install
ln -s "$(pwd)/plugin/index.ts" ~/.config/opencode/plugins/oc-dashboard-plugin.ts
```

## NOTES

- `data.db` in root is a local artifact, not OpenCode's DB. OpenCode's DB defaults to `~/.local/share/opencode/opencode.db`.
- `plugin/` has its own `package.json` and `node_modules/` — it's a separate package for the `@opencode-ai/plugin` type.
- `batchGetPendingBackgroundTasks()` in `db.ts` is the most complex query (~40 lines) — parses `bg_` task IDs from tool output JSON.
- Frontend uses CSS Grid layout with sidebar (240px) + main area. Dark theme only (GitHub-inspired palette).
- Archive threshold: sessions inactive >3 days are moved to archived view.
- `Bun` type is declared locally in `server.ts` (lines 28-32) — not from `bun-types`.
