# EverythinInAI Engine: State-Machine Architecture

## Overview
The fragile n8n linear pipeline has been replaced with a Node.js-based state-machine discovery engine. n8n will now act solely as a cron-trigger, firing off a webhook to execute this engine or invoking a shell command.

## Core Components

1.  **State Machine (The Orchestrator):**
    Manages the lifecycle of a discovery run: `INIT` -> `COLLECT` -> `NORMALIZE` -> `PRE_FILTER` -> `CLASSIFY` -> `MERGE` -> `COMMIT` -> `DONE`. It uses checkpointing so if the process crashes, it resumes from the last successful state.

2.  **Data Layer (Supabase / Postgres):**
    The `data.json` GitHub bottleneck is eliminated. We use a real relational database for atomic writes, concurrency control, and fast fuzzy deduplication.
    *   Table `tools`: The core directory.
    *   Table `discovery_queue`: Items waiting for Gemini classification.
    *   Table `runs`: Tracking execution state and backfill progress.

3.  **Queue Manager & Rate Limiter:**
    A dynamic queue using `p-limit` controls concurrency to the Gemini API. If a 429 (Too Many Requests) is hit, it applies exponential backoff.

4.  **Source Collectors (Plugins):**
    Modular fetchers that handle their own pagination.
    *   `hn.js`: Algolia pagination to fetch all 10,000+ historical tools.
    *   `github.js`: GraphQL or paginated REST to bypass the 1,000 limit.
    *   `rss.js`: Robust XML parsing using `fast-xml-parser`.

5.  **Intelligence Layer (Heuristic v4):**
    *   **Fuzzy Dedup:** Uses `natural` (Jaro-Winkler) to detect duplicate names ("Chatbase" vs "Chatbase AI").
    *   **Smarter Scoring:** Penalizes "listicles" and "news" patterns more aggressively.

## The Cold Start Strategy
Instead of fetching 3 years of data and trying to process it in one go, the backfill is broken into **monthly chunks**. The state machine tracks the `current_backfill_month`. Each run processes one month, commits to the database, and updates the pointer. This makes the 3-year backfill indestructible.
