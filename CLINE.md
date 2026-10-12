# Cline live mode (this fork)

This is Wes Bos's [photo-frame dashboard](https://github.com/wesbos/photo-frame-dashboard)
forked to double as a **live Cline status wall**. A new **Cline** rail item shows what
your Cline agents are doing right now: session cards (model, workspace, status lamp,
token/cost meters, latest tool actions), a team/task board, scheduled runs, and a
one-line-per-minute ticker. When no agents are running it stays a normal home dashboard.

Everything here is additive — the original views are untouched.

## How it works

```
~/.cline/data/db/*.db ─┐
~/.cline/data/sessions/├─ poll 5 s ─→ relay/index.mjs ──PUT /api/push──▶ Cloudflare Worker
   (SQLite, read-only) ┘                (Node ≥ 22.5, zero deps)         (stores doc in R2
                                                                              + serves static)
        │  also serves                          GET /api/cline ──poll 15 s──▶ dashboard (this
        └────────── GET :8799/api/state ──────────────────────────────────────  code, incl. the
               (LAN frames can load the whole wall straight from the relay)      Android WebView)
```

- `relay/index.mjs` — the daemon. Reads `sessions.db` (authoritative status), the per-session
  `.messages.json` (token metrics + tool actions), `teams.db` (team board) and the schedules
  tables, redacts anything that looks like a key, and ships a small JSON doc.
- `dashboard/src/index.js` — hybrid worker: serves the built static dashboard **and**
  `GET /api/cline` / `PUT /api/push` (state stored in R2, binding `CLINE`).
- `dashboard/js/live.js` + `js/views/cline.js` + `css/views/cline.css` — the wall itself.

The relay's state doc is v1: `{ v, host, cline_version, generated_at, summary, sessions[],
teams[], schedules[] }`. Sessions carry derived state: `running` (fresh activity),
`waiting` (5+ min silent), `idle`, `done`, `error`.

## Quickstart (local)

```sh
cd cline-wall
cd dashboard && npm i && npm run build && cd ..

node relay/index.mjs                # 127.0.0.1:8799 — open http://127.0.0.1:8799
```

The relay serves the built dashboard from `:8799` itself, so local needs no Cloudflare at all.
For a fast dev loop instead: `npm run dev` (vite, :8788) + `npx wrangler dev --port 8790`
in `dashboard/` (vite proxies `/api` to the worker), then `node relay/index.mjs
--port 8799` is optional.

## Quickstart (Cloudflare)

```sh
cd dashboard
npm run build
wrangler r2 bucket create cline-state          # once
wrangler secret put CLINE_SECRET               # e.g. a long random string
wrangler deploy                                # → https://home-dashboard.<you>.workers.dev
```

On the machine that runs Cline:

```sh
CLINE_WALL_URL=https://home-dashboard.<you>.workers.dev \
CLINE_WALL_SECRET=<same secret> \
node relay/index.mjs
```

Run it as a long-lived process (tmux/launchd). The relay pushes on change plus a 15 s
heartbeat, so the wall goes stale (amber indicator) within ~2 min if the machine sleeps.
Without `CLINE_SECRET` the push endpoint is open — fine on a private network, never on a
public deployment.

## Photo frame (Android)

The kiosk WebView (Chromium 106) runs this dashboard unchanged — `:8799` serves it as a
static site and `live.js` polls the same-origin `/api/cline`. Point the kiosk's
`DEFAULT_URL` (`kiosk/src/com/wesbos/homehq/MainActivity.java`) at
`http://<mac-lan-ip>:8799/#cline` (start the relay with `--lan`) — or skip the rebuild and
launch with `adb shell am start -a android.intent.action.VIEW -d http://<mac-lan-ip>:8799/#cline
-n com.wesbos.homehq/.MainActivity`.

The `#cline` hash is what makes the frame a *wall*:

- boots straight into the Cline view with the **real clock** (the original demo's
  fake 3:18 PM weekday + demo toast only apply to other views);
- **wall-held rule** (`app.js` → `wallHeld()`): once any state doc has arrived,
  idle logic never bounces the wall back to Home and never dims it to ambient —
  the wall stays bright and readable. Stale feed = amber indicator on the wall,
  last known state stays visible.
- If the relay was never reached (no state doc), the original photo-frame idle
  behavior applies: after 60 s idle it returns to Home and, at 2 min, dims to
  ambient — i.e. it's a photo frame again until the relay comes back.

## Security model

- The relay never opens `providers.json` (API keys) — it only reads the SQLite DBs and
  message files.
- Every free-text field (tool args, commands, titles) is truncated to ~72 chars and
  scanned for key-shaped strings (`sk-…`, `ghp_…`, `Bearer …`, `token = …`), which are
  masked to a 3-char prefix.
- Workspace paths are shipped as **basenames only** unless you set `RELAY_FULL_PATHS=1`.
- Push to the worker requires the bearer secret when `CLINE_SECRET` is set.

## Tuning

| Knob | Where | Default |
| --- | --- | --- |
| rescan interval | `POLL_MS` in `relay/index.mjs` | 5 s |
| push heartbeat | `PUSH_HEARTBEAT_MS` | 15 s |
| max sessions in doc | `MAX_SESSIONS` | 12 |
| "waiting" threshold | `IDLE_WARN_MS` | 5 min |
| frame poll cadence | `POLL_MS` in `dashboard/js/live.js` | 15 s |
| stale threshold | `STALE_MS` in `dashboard/js/live.js` | 2 min |
| local port / state dir | `CLINE_WALL_PORT`, `CLINE_HOME` env | `8799`, `~/.cline` |

## Troubleshooting

- **Wall says "No live feed yet"** — relay not running on the Cline machine, or the
  frame can't reach the endpoint (check `/healthz`).
- **`push rejected: 403`** in relay log — `CLINE_WALL_SECRET` ≠ worker `CLINE_SECRET`.
- **`cline_version` is null** — `cline` isn't on the relay process's `PATH` (cosmetic).
- Cline schema drift (tables/fields change across releases) is tolerated: the relay logs
  nothing and the wall shows what it can get; missing fields just render as `—`.