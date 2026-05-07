# Avi — Ideation Engine (Phase 8)

The brain. Picks today's best signal and drafts 3 Reel concepts every morning.

## Components

| File | Purpose |
|---|---|
| `signal_picker.js` | Scans last 48h of `ai_signals`, scores with freshness/engagement/recency-penalty, returns top winners. |
| `concept_drafter.js` | Sends chosen signal + Avi's persona DNA to Gemini 2.5 Flash, gets back 3 concepts (hot_take / explainer / humor). |
| `telegram_notify.js` | Pushes concepts to operator's Telegram for review. |
| `run_daily.js` | Orchestrator. Runs everything end-to-end. |

## Manual run

```bash
# Dry run (no DB writes, no Telegram)
node avatar/ideation/run_daily.js --dry-run

# Real run (writes 3 drafts, marks Concept A winner, sends Telegram)
node avatar/ideation/run_daily.js

# Force lure level (1-4)
node avatar/ideation/run_daily.js --force-lure=4
```

## Cron

Runs daily at 08:00 IST via `everythinginai-ideation.timer`.
