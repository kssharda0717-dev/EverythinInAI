# Avi — Lifestyle Reels (Phase 14)

Pure aesthetic Avi content for the **IG Subscriptions paywall**. No script,
no scraped signal — just visually beautiful "day-in-life" moments designed
for the lure 3-4 audience that subscribes for intimacy with Avi as a creator.

## Moods

| Key | Vibe |
|---|---|
| `morning_routine` | Bed → kitchen → journal → window — soft sunlit start |
| `cafe`            | Laptop session, coffee, candid laugh — Bandra cafe vibes |
| `working`         | Desk + laptop + journal — focused intellectual energy |
| `golden_hour`     | Bandra rooftop at sunset — contemplative + cinematic |
| `reading`         | Bookshelf nook, hardcover open, soft window light |

## Usage

```bash
# Random mood
node avatar/lifestyle/lifestyle_worker.js

# Specific mood
node avatar/lifestyle/lifestyle_worker.js --mood=morning_routine

# Specific mood + outfit override
node avatar/lifestyle/lifestyle_worker.js --mood=cafe --outfit=oversized_cardigan

# Dry run (prints prompts, no spend)
node avatar/lifestyle/lifestyle_worker.js --dry-run --mood=golden_hour
```

## Cost

Per Lifestyle Reel:
- 4 keyframes × $0.025 (Flux + LoRA) = $0.10
- Music + ffmpeg = $0
- **Total: ~$0.10**

Cheaper than tech Reels because there's no lip-sync (no speaking), just
Ken Burns motion + ambient music + brand watermark + outro.

## Output

Reels are saved to:
- Storage: `avi-images/reels/lifestyle/<mood>-<timestamp>/<file>.mp4`
- 1080×1350 (4:5 IG-Reel safe), 20 sec, 30 fps
- @avi.in.ai watermark + EVERYTHININAI.COM outro burned in
