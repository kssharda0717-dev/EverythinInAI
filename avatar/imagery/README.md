# Avi — Imagery Layer (Phase 9)

Generates Avi's photo-real portraits and per-Reel keyframes using Replicate (Flux + PuLID).

## Files

| File | Purpose |
|---|---|
| `replicate_client.js` | Thin Replicate API wrapper with pinned model versions |
| `storage.js` | Rehosts Replicate's expiring URLs into Supabase Storage permanently |
| `generate_face_anchors.js` | One-shot: produces 4 candidate Avi portraits |
| `choose_face_anchor.js` | Locks one candidate as Avi's permanent face |
| `image_worker.js` | Renders all keyframes for a Reel concept (face-locked via PuLID) |

## Setup (one-time)

```bash
# 1. Apply schema in Supabase SQL editor
sql/006_face_anchors_schema.sql

# 2. Generate 4 candidate portraits of Avi
node avatar/imagery/generate_face_anchors.js

# (open the URLs in your browser, pick the best)

# 3. Lock the chosen one as Avi's permanent face
node avatar/imagery/choose_face_anchor.js <face_anchor_id>
```

## Per-Reel usage

```bash
# Render all keyframes for today's winning concept
node avatar/imagery/image_worker.js --winner

# Or for a specific concept_id
node avatar/imagery/image_worker.js <concept_id>

# Dry-run to see prompts without spending
node avatar/imagery/image_worker.js --winner --dry-run
```

## Cost model

| Operation | Cost |
|---|---|
| Face anchor generation (one-time, 4 candidates) | ~$0.16 |
| Per Reel (4 keyframes, face-locked) | ~$0.20 |
| Monthly @ 7 Reels/week | ~$6 |
