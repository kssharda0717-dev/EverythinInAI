# Avi — Video Layer (Phase 11 v2: talking-head)

Final Reel = lip-synced talking head + word-level captions, 1080×1350 MP4.

## Files

| File | Purpose |
|---|---|
| `caption_generator.js` | Whisper word-level → ASS cues |
| `lipsync_worker.js` | Hero keyframe + voice WAV → SadTalker → talking-head MP4 |
| `video_assembler.js` | (legacy slideshow assembler, kept for reference) |
| `video_worker.js` | Burns captions onto talking-head + scales to 1080x1350 |

## Pipeline (4 commands per Reel)

```bash
# 1. Render ONE photoreal Avi hero keyframe (~$0.025, ~30s)
node avatar/imagery/hero_worker.js --winner

# 2. Generate voice track (~$0.03, ~30s)
node avatar/voice/voice_worker.js --winner

# 3. Lip-sync the hero to the voice (~$0.10, ~60-90s)
node avatar/video/lipsync_worker.js --winner

# 4. Burn captions + final 1080x1350 (free, ~30s)
node avatar/video/video_worker.js --winner
```

End-to-end: ~3 min, ~$0.17/Reel.

The new design: ONE hero keyframe (front-facing, locked outfit), animated
via SadTalker for lip-sync, with word-level TikTok-style captions burned in.
No more slideshow chaos.

## Output spec

- Resolution: 1080×1350 (4:5 IG-Reel safe)
- FPS: 30
- Codec: H.264 + AAC
- Captions: TikTok-style 1-2 word cues, animated fade in/out
- Ken Burns: subtle zoom + pan on each keyframe, crossfade between
