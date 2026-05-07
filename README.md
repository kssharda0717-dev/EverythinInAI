# EverythinInAI — Unified Project

The world's most comprehensive real-time directory of AI tools.
Frontend (React + Vite) + Backend Discovery Engine (Node.js + Supabase) in a single repository.

## Architecture

```
everythinginai-unified/
├── client/               # Frontend — React 19, Vite, Tailwind 4, Framer Motion
│   └── src/
│       ├── components/   # UI components (Arctic Vibe 2026 design)
│       ├── hooks/        # useTools, useStats — fetch from /api or fallback to mock
│       ├── lib/          # data.ts (types + mock), supabase.ts (API client)
│       └── pages/        # Home, Launchpad, NotFound
│
├── engine/               # Backend — Discovery Engine
│   ├── collectors/       # Source plugins (HN, GitHub, RSS)
│   ├── core/             # State machine, database, rate limiter, backfill
│   ├── intelligence/     # Heuristic pre-filter, Gemini classifier, GitHub committer
│   ├── cli.js            # CLI entry point (node engine/cli.js <command>)
│   └── api-server.js     # Standalone HTTP API (port 3847)
│
├── server/               # Unified Express server (serves frontend + /api routes)
│   └── index.ts          # API routes + static file serving
│
├── sql/                  # Database schema
│   └── 001_schema.sql    # Supabase/Postgres tables, indexes, functions
│
├── package.json          # Merged dependencies (frontend + backend)
└── vite.config.ts        # Vite config with API proxy for development
```

## Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Set Up Supabase

1. Create a free Supabase project at [supabase.com](https://supabase.com)
2. Run `sql/001_schema.sql` in the Supabase SQL Editor
3. Copy your project URL, anon key, and service role key

### 3. Configure Environment

Create a `.env` file in the project root:

```env
# Frontend (browser-safe)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your-anon-key

# Backend (server-only)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=eyJ...your-service-role-key
GEMINI_API_KEY=your-gemini-api-key

# Optional
GITHUB_TOKEN=ghp_your-token
GITHUB_REPO=kssharda0717-dev/EverythinInAI
ENGINE_MODE=incremental
```

See `ENV_SETUP.md` for the full variable reference.

### 4. Run in Development

```bash
# Frontend only (mock data fallback)
pnpm dev

# Frontend + API server (live data)
pnpm dev:all

# Engine API server only
pnpm engine:server
```

### 5. Run the Discovery Engine

```bash
# Incremental discovery (last 6 hours)
pnpm engine:incremental

# Initialize 3-year backfill
pnpm engine:backfill-init

# Process next backfill month
pnpm engine:backfill

# Check engine status
pnpm engine:status
```

### 6. Build for Production

```bash
pnpm build
pnpm start
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tools` | List tools (paginated, filterable) |
| GET | `/api/tools/search?q=` | Search tools |
| GET | `/api/tools/categories` | Categories with counts |
| GET | `/api/tools/:slug` | Single tool detail |
| GET | `/api/stats` | Dashboard statistics |
| POST | `/api/submit` | Developer tool submission |
| GET | `/api/engine/health` | Engine health check |
| GET | `/api/engine/status` | Engine run status |
| GET | `/api/engine/export` | Export tools as JSON |

## How It Works

1. **Frontend** fetches tools from `/api/tools` — if the API is unavailable, it falls back to 18 hardcoded mock tools
2. **Server** (`server/index.ts`) serves both the static frontend and API routes that query Supabase
3. **Engine** (`engine/`) runs independently via CLI or its own HTTP API, discovering and classifying AI tools from HN, GitHub, RSS feeds using Gemini 1.5 Flash
4. **Supabase** stores everything — tools, discovery queue, run history, backfill progress

## n8n Integration

Import `n8n-orchestrator-workflow.json` into your n8n instance to schedule automated discovery runs via the engine's HTTP API.
