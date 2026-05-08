# Avi — Video Layer (Phase 11)

Final assembly: keyframes + voice + word-level captions → 1080×1350 MP4 Reel.

## Files

| File | Purpose |
|---|---|
| `caption_generator.js` | Whisper word-level → SRT/ASS cues |
| `video_assembler.js` | ffmpeg Ken-Burns + xfade + caption burn |
| `video_worker.js` | Orchestrator: pulls concept → renders MP4 → uploads |

## Pipeline (3 commands per Reel)

```bash
# 1. Render the 4 photoreal Avi keyframes (~$0.10, ~3 min)
node avatar/imagery/image_worker.js --winner

# 2. Generate the voice track (~$0.03, ~30s)
node avatar/voice/voice_worker.js --winner

# 3. Stitch into a Reel (~$0.01, ~60s)
node avatar/video/video_worker.js --winner
```

End-to-end: ~4 min, ~$0.14/Reel.

## Output spec

- Resolution: 1080×1350 (4:5 IG-Reel safe)
- FPS: 30
- Codec: H.264 + AAC
- Captions: TikTok-style 1-2 word cues, animated fade in/out
- Ken Burns: subtle zoom + pan on each keyframe, crossfade between
