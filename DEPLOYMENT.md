# EverythinInAI Engine — Deployment Guide

The fragile linear n8n workflow has been entirely replaced with a production-grade, state-machine-driven Node.js engine. It is designed to run anywhere (Oracle Cloud VM, Render, Railway, or even within n8n via the Execute Command node) and uses Supabase as its indestructible database layer.

## What Was Fixed

1.  **The GitHub Bottleneck:** Eliminated. Data now lives in a proper Postgres database (Supabase) with fuzzy search capabilities and concurrent write support. A backwards-compatible GitHub committer is included if you still need `data.json` to update.
2.  **The 1,000-Item Crash:** Fixed. Source collectors now use intelligent pagination (HN Algolia) and binary date-range splitting (GitHub) to bypass API limits and fetch *everything*.
3.  **The Memory Explosion:** Fixed. The State Machine processes data in phases, checkpoints to the database, and uses a queue table. It will never run out of memory, even on a 1GB Oracle Cloud VM.
4.  **The "Wait 4s" Rate Limiter:** Replaced with the `DynamicRateLimiter`. It tracks Gemini's RPM, TPM, and RPD limits simultaneously, applying exponential backoff if a 429 occurs, and pausing automatically when daily limits approach.
5.  **The Cold Start Problem:** The 3-year backfill is now managed by the `BackfillManager`. It breaks the 3 years into 36 independent monthly chunks. You run it 36 times (e.g., via a 15-minute cron), and it safely backfills the entire history without hitting limits or crashing.

## Setup Instructions

### 1. Database Setup
1. Create a free project on [Supabase](https://supabase.com).
2. Go to the SQL Editor and paste the contents of `sql/001_schema.sql`. Run it.
3. This creates the `tools`, `discovery_queue`, `runs`, and `backfill_progress` tables, along with the fuzzy deduplication function.

### 2. Environment Configuration
1. Copy `.env.example` to `.env`.
2. Fill in your `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `GEMINI_API_KEY`.
3. (Optional) Fill in `GITHUB_TOKEN` if you want the engine to continue updating `data.json`.

### 3. Running the Engine

You have two ways to run this on your Oracle Cloud instance:

#### Option A: CLI / Cron (Recommended)
This is the most robust way. Just set up cron jobs on your Oracle VM.

```bash
cd /path/to/everythininai-engine
npm install

# Run the normal 6-hour incremental discovery
node src/index.js incremental

# Initialize the 3-year cold start
node src/index.js backfill-init

# Run ONE month of the cold start (put this on a 15-min cron until done)
node src/index.js backfill

# Check status
node src/index.js status
```

#### Option B: n8n Orchestrator
If you prefer to keep n8n as the visual trigger:
1. Import `n8n-orchestrator-workflow.json` into your n8n instance.
2. It uses the "Execute Command" node to run `node src/index.js incremental`.
3. It parses the JSON output from the engine and provides success/failure routing for alerts.

## The Intelligence Layer (v4)

The heuristic pre-filter has been completely rewritten. It no longer relies on rigid keyword drops. Instead, it uses a fluid scoring system (-50 to +100) based on:
*   **Anti-patterns:** Aggressively penalizes listicles ("Top 10 AI tools"), news domains, and academic papers.
*   **Freshness:** Gives a bonus to items published in the last 48 hours.
*   **URL Structure:** Detects product patterns (custom domains, short paths) vs. article patterns (dates in URLs).
*   **Fuzzy Dedup:** Uses trigram similarity in Postgres to catch "Chatbase" vs "Chatbase AI" before sending to Gemini.

You are now ready to scale to 100,000+ tools.
