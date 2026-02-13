# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NarraFork is an AI-powered collaborative programming platform built around a "narrative forking" metaphor. Software development is modeled as a branching story network where each work branch (Chapter) has its own AI narrator (Claude Code session) operating in an isolated git worktree with optional Podman container environments. Designed for small-team private deployment with shared project data.

**Core domain concepts:**
- **Chapter** — work unit = git worktree + AI session(s), with statuses: active/dormant/merged/abandoned
- **Narrator** — Claude Code session bound to a chapter (or standalone), with streaming output and permission control
- **Fork types** — Meanwhile (parallel work), WhatIf (experimental exploration)
- **Story Network** — directed graph of all chapter fork/merge relationships

## Commands

| Command | Purpose |
|---------|---------|
| `bun run dev` | Backend: push DB schema + hot-reload server (port 7778) |
| `bun run dev:frontend` | Frontend: Vite dev server (port 5173, proxies /api and /ws to 7778) |
| `bun run build` | Build frontend to `dist/frontend/` |
| `bun run start` | Production: push DB schema + serve backend + static frontend |
| `bun run db:push` | Push Drizzle schema directly to SQLite (no migration files) |
| `bun run db:generate` | Generate Drizzle migration SQL files |
| `bun run db:migrate` | Run migrations from `./drizzle/` |
| `bun run check` | Biome lint + format check |
| `bun run format` | Biome lint + format with auto-fix |

**Dev requires two processes:** `bun run dev` (backend) and `bun run dev:frontend` (frontend).

No test framework is configured.

## Tech Stack

- **Runtime:** Bun (≥ 1.2), all scripts via `bun run`/`bunx`
- **Backend:** Hono v4 on Bun.serve(), SQLite via `bun:sqlite`, Drizzle ORM
- **Frontend:** React 19 + Mantine v7 (dark theme, indigo primary), TanStack Router (file-based), TanStack React Query, React Flow for graph visualization, xterm.js for terminals, react-i18next for i18n
- **AI:** `@anthropic-ai/claude-agent-sdk` for narrator sessions
- **Validation:** Zod v4
- **Linting:** Biome v2 (tabs, 100-char line width, recommended rules)
- **External deps:** git, dtach (terminal persistence), optionally podman (containers)

## Architecture

### Backend (`server/`)

```
server/
  index.ts          — Bun.serve() entry: HTTP via Hono + WS upgrade
  app.ts            — Hono route registration + global error handler
  db/
    schema.ts       — Drizzle table definitions (projects, chapters, narrators, etc.)
    relations.ts    — Drizzle relation definitions
    index.ts        — DB init (WAL mode, foreign keys, FTS5 virtual tables + triggers)
  middleware/auth.ts — requireAuth / requireAdmin JWT middleware
  lib/
    auth.ts         — JWT sign/verify (HS256, 7-day), bcrypt registration/login
    validators.ts   — Zod schemas for all API inputs
    event-bus.ts    — Typed EventEmitter for cross-service decoupling
    settings/       — File-based settings (~/.narrafork/settings.json) with deep-merge defaults
    errors.ts       — AppError hierarchy (NotFoundError, ValidationError)
    id.ts           — nanoid generators (21-char default, 8-char short)
  routes/           — Hono route groups mounted at /api/*
  services/         — Business logic (chapter CRUD, fork, merge, narrator sessions, git, terminals, containers)
  websocket/        — Bun WebSocket handlers for narrator events and terminal I/O
```

**Key patterns:**
- **Event bus** (`lib/event-bus.ts`) decouples services → WebSocket broadcast. All cross-service communication flows through typed events.
- **Narrator sessions** use Claude Agent SDK `query()` with SSE streaming on HTTP + parallel WebSocket broadcast. Permission requests pause the session with a Promise resolved by user decision (5-min timeout).
- **Fork context inheritance** has three modes: `full` (defer SDK session fork), `compressed` (Haiku-generated summary in system prompt), `fresh` (no context).
- **Git worktrees** per active chapter under `<repo>/.worktrees/`. Dormant chapters remove worktree but preserve branch.
- **Container management** via Podman compose with port allocation from a configurable pool (default 10000–20000).
- **Terminal persistence** via dtach — terminals survive server restarts.
- **Batch merge** orchestrates multi-chapter merges with conflict detection, interactive WebSocket decisions, and AI-assisted conflict resolution.

**Database:** SQLite at `~/.narrafork/narrafork.db`. All PKs are nanoid text IDs. FTS5 virtual tables for chapters and narrator messages with sync triggers.

**Auth:** JWT in `Authorization: Bearer` header (HTTP) or `?token=` query param (WebSocket). First registered user gets admin. JWT secret auto-generated in settings file.

### Frontend (`frontend/`)

```
frontend/
  main.tsx            — i18n init + MantineProvider + QueryClient + RouterProvider
  lib/api.ts          — Typed fetch wrapper with JWT injection and 401 redirect
  lib/i18n.ts         — i18next initialization with language detector + locale imports
  locales/            — Translation JSON files: en/ and zh-CN/, 12 namespaces each
  routes/             — TanStack file-based routes (auto code-splitting)
  hooks/              — React Query hooks per resource + WebSocket hooks
  components/         — Domain-grouped: chapter/, narrator/, terminal/, container/, graph/
```

**Route structure:** `__root.tsx` (AppShell layout) → dashboard, projects, chapters, sessions, settings, search, graph visualization.

**Vite dev proxy:** `/api/*` → `localhost:7778`, `/ws/*` → `ws://localhost:7778`.

### API Routes

All under `/api/`. Public: `/api/auth/*`, `/api/health`, `/api/auth/status`. Everything else requires JWT.

- `/api/projects` — CRUD + `/:id/graph`
- `/api/chapters` — CRUD + fork, merge, merge-check, ai-resolve, dormant, wake, cleanup, batch-merge, containers
- `/api/narrators` — CRUD + messages (SSE), interrupt, permission-mode, permissions, approve/deny
- `/api/terminals` — CRUD
- `/api/sessions` — Standalone narrator sessions (no chapter)
- `/api/settings`, `/api/admin`, `/api/search`, `/api/mcp`

**WebSocket:** `/ws/narrator?token=` (subscribe/unsubscribe model), `/ws/terminal?terminalId=&token=` (stdin/stdout piping)

## Code Style

- **Biome** enforces formatting and linting — run `bun run check` before committing
- Indent with **tabs**, max line width **100**
- Path aliases: `@server/*` → `./server/*`, `@frontend/*` → `./frontend/*`
- ESM throughout (`"type": "module"`)
- `routeTree.gen.ts` is auto-generated — do not edit manually
- IDs: use `generateId()` (21-char) or `generateShortId()` (8-char) from `@server/lib/id`
- Errors: throw `AppError` subclasses from `@server/lib/errors` — the global handler serializes them
- Validation: define Zod schemas in `@server/lib/validators.ts`, parse in route handlers
- Settings at `~/.narrafork/settings.json` — access via the `settings` singleton from `@server/lib/settings`

## DESIGN.md

The `DESIGN.md` file (written in Chinese) contains the full project specification including all 5 development phases, detailed database schema, API contracts, and UI wireframes. Consult it for requirements and architectural decisions.

## i18n

Frontend internationalization uses `react-i18next` with `i18next-browser-languagedetector`.

- **Languages:** English (default fallback) + Simplified Chinese (`zh-CN`)
- **Config:** `frontend/lib/i18n.ts` — eagerly imports all locale JSONs, no async loading
- **Detection:** localStorage key `narrafork_lang` → browser navigator → fallback `en`
- **Namespaces:** 12 feature-scoped JSON files per language under `frontend/locales/{en,zh-CN}/`: common, nav, dashboard, projects, chapters, sessions, settings, search, narrator, terminal, containers, graph
- **Switcher:** `frontend/components/LanguageSwitcher.tsx` — Mantine Select in the app header
- **Usage pattern:** `const { t } = useTranslation("namespace")` in components, `t("key", { param })` for interpolation
- **Multi-namespace:** `const { t } = useTranslation("chapters"); const { t: tc } = useTranslation("common");`
- **Adding strings:** add keys to both `en/*.json` and `zh-CN/*.json`, use `t("key")` in JSX
