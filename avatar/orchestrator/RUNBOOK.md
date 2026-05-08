# Avi — Daily Operating Runbook (Phase 15)

## What happens automatically

Every morning at **8 AM IST**:

| Day | What you'll see in Telegram |
|---|---|
| Mon-Thu | "🎬 Tech Reel day. 3 concepts will arrive shortly." → 3 concepts → reply `/pick_<id>` |
| Fri | "📸 Lure Photo day. Reply /go to fire it." → reply `/go` |
| Sat-Sun | "🌅 Lifestyle Reel day. Reply /go to fire it." → reply `/go` |

After you reply, the render runs in background (~10 min for tech reels, ~3 min for others). When done, Telegram pings you with:
- 📥 Direct download URL
- 📝 Caption to copy-paste
- 🏷 Hashtags to copy-paste

You then post to Instagram manually.

## Hard guarantees

- **Max 1 piece of content per day** (UNIQUE constraint on `content_calendar`)
- **No auto-pick.** If you don't reply, nothing renders. Zero surprise costs.
- **All renders cost-capped:** ~$0.55/tech reel, $0.10/lifestyle, $0.025/lure photo
- **Weekly cap: ~$2.40** ($10/month)

## Telegram commands

```
/pick_<id>   — pick a tech-reel concept (8-char id from morning ideation)
/go          — fire today's lure-photo or lifestyle-reel render
/status      — check today's calendar state + URLs
/help        — list all commands
```

## What's running on the VM

| Service | Schedule | Purpose |
|---|---|---|
| `everythinginai-morning.timer` | Daily 7:55 AM IST | Tells you what's on for today |
| `everythinginai-ideation.timer` | Daily 8:00 AM IST | Drafts 3 tech concepts (Mon-Thu only; no-ops on other days) |
| `everythinginai-telegram-listener.service` | Always-on daemon | Listens for /pick + /go commands |

## First-time setup (one command)

```bash
cd /home/ubuntu/everythinginai-unified
git pull origin main

# Apply schema
psql $SUPABASE_DB_URL -f sql/012_content_calendar.sql

# Install systemd units
sudo cp deploy/systemd/everythinginai-morning.{service,timer} /etc/systemd/system/
sudo cp deploy/systemd/everythinginai-telegram-listener.service /etc/systemd/system/
sudo touch /var/log/everythinginai-telegram.log
sudo chown ubuntu:ubuntu /var/log/everythinginai-telegram.log

sudo systemctl daemon-reload
sudo systemctl enable --now everythinginai-morning.timer
sudo systemctl enable --now everythinginai-telegram-listener.service

# Verify
systemctl list-timers everythinginai-* --no-pager
systemctl status everythinginai-telegram-listener
```

## Daily flow examples

### Tech-reel day (Mon-Thu)
```
07:55  ← "☀️ Monday — Tech Reel day. 3 concepts arriving shortly."
08:00  ← 3 concepts dropped: /pick_d5491bdb /pick_9a7ff0da /pick_382f0ebc
        (you read them on the bus, decide later)
12:00  ← (you reply) "/pick_d5491bdb"
12:00  ← "✅ Picked Concept A. Render started. ETA ~10 min."
12:10  ← "🎬 TECH REEL READY — Mon  📥 https://...mp4  📝 caption...  🏷 hashtags..."
        (you download + post to IG)
```

### Lure-photo day (Fri)
```
07:55  ← "📸 Friday — Lure Photo day. Reply /go to fire it."
        (you reply at any time)
13:00  ← (you reply) "/go"
13:00  ← "🚀 Firing today's LURE PHOTO."
13:01  ← "📸 LURE PHOTO READY  📥 https://...webp  📝 caption  🏷 hashtags"
```

### Lifestyle-reel day (Sat-Sun)
Same as lure-photo day, but takes ~5 min instead of 30 sec, and produces a 20-sec MP4.

## Troubleshooting

```bash
# Listener not responding to commands?
sudo systemctl status everythinginai-telegram-listener
sudo journalctl -u everythinginai-telegram-listener -n 50

# Render hung?
ls -la /tmp/render-*.log
tail -f /tmp/render-<calendar-id>.log

# Force-fire a render manually (skip Telegram)
node avatar/orchestrator/render_winner.js --today

# Check today's calendar state
node -e "
const db = require('./engine/core/database').getClient();
db.from('content_calendar').select('*').eq('target_date', new Date().toISOString().slice(0,10))
  .then(({data}) => console.log(JSON.stringify(data, null, 2)));
"
```

## Cost tracking

```bash
# See all this week's renders
node -e "
const db = require('./engine/core/database').getClient();
const since = new Date(Date.now() - 7*86400_000).toISOString().slice(0,10);
db.from('content_calendar')
  .select('target_date, content_type, state, cost_usd, output_url')
  .gte('target_date', since)
  .order('target_date', { ascending: false })
  .then(({data}) => console.table(data));
"
```
