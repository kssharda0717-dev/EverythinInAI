# Avi — Voice Layer (Phase 10)

Generates Avi's voiceover for each Reel using `resemble-ai/chatterbox` (voice cloning TTS).

## Setup (one-time)

```bash
# 1. Apply schema
sql/008_voice_schema.sql

# 2. Install ffmpeg + yt-dlp on the VM
sudo apt-get update && sudo apt-get install -y ffmpeg

# 3. Setup the default Mostly Sane reference clip + test sample
node avatar/voice/setup_voice_reference.js
# Listen to the test sample URL it prints. If you like it, activate.

# 4. Activate the voice
node avatar/voice/activate_voice.js <voice_ref_id_prefix>
```

## Per-Reel usage

```bash
node avatar/voice/voice_worker.js --winner            # today's winner
node avatar/voice/voice_worker.js <concept_id>
```

## Cost
- Reference setup (one-time): ~$0.05
- Per Reel: ~$0.03

## Try a different reference
```bash
node avatar/voice/setup_voice_reference.js \
  --url='https://www.youtube.com/watch?v=...' \
  --label='kusha_kapila' \
  --start=15 --duration=10 \
  --notes='Kusha tonal alternative'
```
