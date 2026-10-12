#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Cline → dashboard relay
//
// Zero-dependency Node daemon (Node >= 22.5, uses node:sqlite) that watches
// the local Cline state directory (~/.cline by default) and publishes a
// small, redacted JSON document:
//
//   1. Served locally:  GET http://127.0.0.1:8799/api/state (alias /api/cline)
//      Also serves the built dashboard (dashboard/dist) at / when present,
//      so a photo frame on the LAN can point straight at this machine.
//
//   2. Pushed to the wall: PUT $CLINE_WALL_URL/api/push
//      (Bearer $CLINE_WALL_SECRET, must match the Worker's CLINE_SECRET)
//
// Usage:
//   node relay/index.mjs --once                     # print current state, exit
//   node relay/index.mjs                            # local mode, 127.0.0.1:8799
//   node relay/index.mjs --lan                      # bind 0.0.0.0 (LAN frames)
//   CLINE_WALL_URL=https://wall.example.com \
//   CLINE_WALL_SECRET=... node relay/index.mjs      # push to Cloudflare Worker
//
// Env:
//   CLINE_HOME           state dir (default ~/.cline)
//   CLINE_WALL_URL       worker base URL to push to
//   CLINE_WALL_SECRET    bearer secret for /api/push
//   CLINE_WALL_PORT      local port (default 8799)
//   RELAY_FULL_PATHS=1   include full workspace paths (basename only by default)
//
// Security: never reads provider credentials (providers.json is not opened).
// Free text and tool arguments are truncated + redacted before going out, so
// the wall may be public without leaking secrets.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// ------------------------------------------------------------------- config
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const arg = (n, d) => { const i = argv.indexOf(n); return i > -1 && argv[i + 1] ? argv[i + 1] : d; };

const HOME_DIR = path.resolve(arg('--dir') || process.env.CLINE_HOME || path.join(os.homedir(), '.cline'));
const PORT = Number(arg('--port', process.env.CLINE_WALL_PORT || 8799));
const BIND = has('--lan') ? '0.0.0.0' : '127.0.0.1';
const WALL_URL = (process.env.CLINE_WALL_URL || '').replace(/\/+$/, '');
const WALL_SECRET = process.env.CLINE_WALL_SECRET || '';
const FULL_PATHS = !!process.env.RELAY_FULL_PATHS;

const POLL_MS = 5000;              // how often we re-scan ~/.cline
const PUSH_HEARTBEAT_MS = 15000;   // max gap between pushes even when unchanged
const MAX_SESSIONS = 12;           // sessions included in the state doc
const IDLE_WARN_MS = 300 * 1000;   // running but silent for 5m → "waiting"

const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'dist');
const DB_DIR = path.join(HOME_DIR, 'data', 'db');
const SESSION_DIR = path.join(HOME_DIR, 'data', 'sessions');

let CLINE_VERSION = null;
execFile('cline', ['--version'], { timeout: 4000, encoding: 'utf8' }, (err, out) => {
  if (!err && out) CLINE_VERSION = out.trim().split('\n').pop();
});

// ------------------------------------------------------------------ helpers
function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function parseTs(v) {
  if (v == null) return null;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return isFinite(t) ? t : null;
}

// API keys / tokens / bearer strings → keep a 3-char prefix, mask the rest.
const SECRET_RE = new RegExp(
  [
    'sk-[A-Za-z0-9_\\-]{10,}',
    'gh[pousr]_[A-Za-z0-9]{10,}',
    'xox[baprs]-[A-Za-z0-9\\-]{10,}',
    'AKIA[A-Z0-9]{12,}',
    'Bearer\\s+[A-Za-z0-9_\\-\\.]{12,}',
    '(?:api[_-]?key|apikey|token|secret|passwd|password|authorization)\\s*[:=]\\s*[\'\"]?[A-Za-z0-9_\\-\\.]{10,}',
  ].join('|'),
  'gi'
);
function redact(s) {
  return String(s)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(SECRET_RE, (m) => m.slice(0, 3) + '•••');
}

// One short, human-readable line per tool call (wall ticker content).
function actionSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  let s = '';
  try {
    if (name === 'run_commands' || name === 'terminal' || name === 'shell') {
      // commands[] entries are either plain strings or {command: "..."} objects
      const c0 = (input.commands && input.commands[0]) || input.command || '';
      s = (typeof c0 === 'object' && c0) ? (c0.command || c0.shell || '') : (c0 || '');
    } else if (name === 'read_files' || name === 'filesystem__read_file' || name === 'filesystem__read_text_file') {
      const f = input.files ? input.files[0] : input.path;
      s = f ? (typeof f === 'string' ? f : f.path) : '';
    } else if (name === 'editor' || name === 'filesystem__edit_file' || name === 'filesystem__write_file') {
      s = input.path || (input.edits ? 'edit file' : 'write file');
    } else if (name === 'search_codebase' || name === 'filesystem__search_files') {
      s = input.queries ? input.queries[0] : (input.pattern || '');
    } else if (name === 'fetch_web_content' || name === 'fetch__fetch') {
      s = input.requests ? (input.requests[0] && input.requests[0].url) : (input.url || '');
    } else if (name === 'ask_question') {
      s = 'asks ' + (Array.isArray(input.options) ? input.options.length : '?') + ' options: ' + ((input.question || '').slice(0, 40));
    } else {
      s = JSON.stringify(input);
    }
  } catch { s = ''; }
  return redact(s).trim().slice(0, 72);
}

// Open a SQLite DB read-only, run one query, close. Never throws.
function dbAll(file, sql, ...params) {
  const p = path.join(DB_DIR, file);
  if (!existsSync(p)) return null;
  let db = null;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    return db.prepare(sql).all(...params);
  } catch {
    return null; // locked / schema drift / missing table — stay quiet
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

// ---------------------------------------------------------------- collection
function collectSessions(now) {
  const rows = dbAll('sessions.db',
    'SELECT session_id, source, pid, started_at, ended_at, exit_code, status, provider, model, ' +
    'cwd, workspace_root, team_name, agent_id, is_subagent, updated_at, messages_path ' +
    'FROM sessions ORDER BY updated_at DESC LIMIT 100') || [];
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const dayMs = day.getTime();
  const out = [];

  for (const r of rows) {
    const msgFile = (r.messages_path && existsSync(r.messages_path))
      ? r.messages_path
      : path.join(SESSION_DIR, r.session_id, r.session_id + '.messages.json');
    let lastTs = 0, tokensToday = 0;
    const tokens = { in: 0, out: 0, cache: 0 };
    const actions = [];
    let agent = r.agent_id || null;

    const m = readJson(msgFile);
    if (m) {
      if (m.agent) agent = agent || m.agent;
      for (const msg of m.messages || []) {
        if (typeof msg.ts === 'number' && msg.ts > lastTs) lastTs = msg.ts;
        if (msg.role === 'assistant' && msg.metrics) {
          const mi = msg.metrics.inputTokens || 0;
          const mo = msg.metrics.outputTokens || 0;
          const mc = (msg.metrics.cacheReadTokens || 0) + (msg.metrics.cacheWriteTokens || 0);
          tokens.in += mi; tokens.out += mo; tokens.cache += mc;
          if (typeof msg.ts === 'number' && msg.ts >= dayMs) tokensToday += mi + mo + mc;
        }
        for (const c of msg.content || []) {
          if (c.type === 'tool_use') actions.push({ ts: msg.ts || 0, tool: c.name || 'tool', summary: actionSummary(c.name, c.input) });
        }
      }
    }
    // newest first; keep the most recent 8
    actions.reverse();
    while (actions.length > 8) actions.pop();

    let mt = 0;
    try { mt = statSync(msgFile).mtimeMs; } catch {}
    const lastActivity = Math.max(lastTs, parseTs(r.updated_at) || 0, mt) || null;
    const idleMs = lastActivity ? Math.max(0, now - lastActivity) : null;

    let state;
    if (r.exit_code != null) state = r.exit_code === 0 ? 'done' : 'error';
    else if (r.status === 'running') state = idleMs != null && idleMs > IDLE_WARN_MS ? 'waiting' : 'running';
    else state = 'idle';

    const ws = r.cwd || r.workspace_root || '';
    out.push({
      id: r.session_id,
      agent: agent || 'agent',
      team: r.team_name || null,
      model: r.model || null,
      provider: r.provider || null,
      workspace: ws ? path.basename(ws) : null,
      ...(FULL_PATHS ? { workspace_path: ws } : {}),
      source: r.source || null,
      subagent: !!r.is_subagent,
      status: r.status || 'unknown',
      state,
      started_at: r.started_at || null,
      ended_at: r.ended_at || null,
      exit_code: r.exit_code,
      updated_at: r.updated_at || null,
      last_activity_at: lastActivity ? new Date(lastActivity).toISOString() : null,
      idle_ms: idleMs,
      tokens: { ...tokens, total: tokens.in + tokens.out + tokens.cache },
      tokens_today: tokensToday,
      cost_usd: null,
      actions,
    });
  }

  const prio = { running: 0, waiting: 1, idle: 2, error: 3, done: 4 };
  out.sort((a, b) =>
    (a.subagent ? 1 : 0) - (b.subagent ? 1 : 0) ||
    (prio[a.state] - prio[b.state]) ||
    (parseTs(b.last_activity_at) || 0) - (parseTs(a.last_activity_at) || 0));
  return out.slice(0, MAX_SESSIONS);
}

function collectTeams() {
  const snaps = dbAll('teams.db', 'SELECT team_name, updated_at, teammates_json FROM team_runtime_snapshot') || [];
  const tasks = dbAll('teams.db', 'SELECT team_name, title, status, assignee FROM team_tasks ORDER BY updated_at DESC LIMIT 60') || [];
  const runs = dbAll('teams.db', 'SELECT team_name, agent_id, status, heartbeat_at FROM team_runs') || [];
  const byTeam = new Map();
  for (const s of snaps) {
    let members = [];
    try {
      const tm = JSON.parse(s.teammates_json || '[]');
      const arr = Array.isArray(tm) ? tm : (tm ? Object.values(tm) : []);
      members = arr.slice(0, 12).map((x) => ({
        id: x.agent_id || x.id || x.name || '?',
        state: x.state || x.status || null,
      }));
    } catch {}
    byTeam.set(s.team_name, { name: s.team_name, updated_at: s.updated_at, members, tasks: [], runs: [] });
  }
  for (const t of tasks) {
    const e = byTeam.get(t.team_name);
    if (e) e.tasks.push({ title: (t.title || '').slice(0, 80), status: t.status, assignee: t.assignee || null });
  }
  for (const r of runs) {
    const e = byTeam.get(r.team_name);
    if (e) e.runs.push({ agent: r.agent_id, status: r.status, heartbeat_at: r.heartbeat_at });
  }
  return [...byTeam.values()]
    .map((t) => ({ name: t.name, updated_at: t.updated_at, members: t.members, tasks: t.tasks.slice(0, 6), runs: t.runs.slice(0, 8) }))
    .slice(0, 6);
}

function collectSchedules() {
  const s = dbAll('sessions.db', 'SELECT schedule_id, name, cron_pattern, enabled, last_run_at, next_run_at FROM schedules LIMIT 12') || [];
  const ex = dbAll('sessions.db', 'SELECT schedule_id, status, tokens_used, cost_usd, triggered_at FROM schedule_executions ORDER BY triggered_at DESC LIMIT 40') || [];
  const lastBy = new Map();
  for (const e of ex) if (!lastBy.has(e.schedule_id)) lastBy.set(e.schedule_id, e);
  return s.map((r) => {
    const l = lastBy.get(r.schedule_id);
    return {
      name: r.name, cron: r.cron_pattern, enabled: !!r.enabled,
      last_run_at: r.last_run_at, next_run_at: r.next_run_at,
      last: l ? { status: l.status, tokens: l.tokens_used || 0, cost_usd: l.cost_usd, at: l.triggered_at } : null,
    };
  }).slice(0, 8);
}

function collect() {
  const now = Date.now();
  const sessions = collectSessions(now);
  const schedules = collectSchedules();

  const summary = {
    sessions_total: sessions.length,
    active: 0, waiting: 0, idle: 0, done: 0, error: 0,
    tokens_today: 0, cost_today_usd: null, last_activity_at: null,
  };
  for (const x of sessions) {
    if (x.state === 'running' || x.state === 'waiting') summary.active++;
    if (x.state === 'waiting') summary.waiting++;
    else if (x.state === 'idle') summary.idle++;
    else if (x.state === 'done') summary.done++;
    else if (x.state === 'error') summary.error++;
    summary.tokens_today += x.tokens_today || 0;
    if (x.last_activity_at && (!summary.last_activity_at || x.last_activity_at > summary.last_activity_at)) {
      summary.last_activity_at = x.last_activity_at;
    }
  }
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const c = dbAll('sessions.db',
    'SELECT SUM(cost_usd) c FROM schedule_executions WHERE triggered_at >= ? AND cost_usd IS NOT NULL', day.toISOString());
  if (c && c[0] && c[0].c != null) summary.cost_today_usd = Number(c[0].c);

  return {
    v: 1,
    host: os.hostname(),
    cline_version: CLINE_VERSION,
    generated_at: new Date(now).toISOString(),
    summary,
    sessions,
    teams: collectTeams(),
    schedules,
  };
}

// ------------------------------------------------------------------- push
async function push(json) {
  if (!WALL_URL) return true;
  try {
    const res = await fetch(WALL_URL + '/api/push', {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(WALL_SECRET ? { authorization: 'Bearer ' + WALL_SECRET } : {}),
      },
      body: json,
    });
    if (!res.ok) console.error('[relay] push rejected:', res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.error('[relay] push failed:', e.message);
    return false;
  }
}

// ------------------------------------------------------------- local server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.json': 'application/json', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
let currentJson = '';

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/api/state' || u.pathname === '/api/cline') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    return res.end(currentJson || '{"v":1,"offline":true,"message":"relay warming up"}');
  }
  if (u.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, wall: WALL_URL || null, dist: existsSync(DIST_DIR), port: PORT }));
  }
  if (existsSync(DIST_DIR)) {
    const rel = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\/+/, '');
    const p = path.normalize(path.join(DIST_DIR, rel));
    if (p.startsWith(DIST_DIR) && existsSync(p) && statSync(p).isFile()) {
      res.writeHead(200, {
        'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
        'cache-control': rel.startsWith('assets/') ? 'max-age=31536000' : 'no-store',
      });
      return res.end(readFileSync(p));
    }
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>cline relay</title>' +
    '<body style="font-family:ui-monospace,Menlo,monospace;padding:40px">' +
    '<h1>cline relay</h1>' +
    '<p>Serving live state at <a href="/api/state">/api/state</a>.</p>' +
    '<p>To also serve the dashboard here: <code>cd dashboard && npm i && npm run build</code></p>');
});

// ------------------------------------------------------------------- loop
let lastDigest = '\u0000', lastPushAt = 0, lastSig = '';
async function loop() {
  let state;
  try { state = collect(); } catch (e) { console.error('[relay] collect error:', e.message); return; }
  currentJson = JSON.stringify(state);
  const { generated_at, ...rest } = state;
  const digest = JSON.stringify(rest);
  const changed = digest !== lastDigest;
  lastDigest = digest;

  if (WALL_URL && (changed || Date.now() - lastPushAt >= PUSH_HEARTBEAT_MS)) {
    if (await push(currentJson)) lastPushAt = Date.now();
  }
  const sig = state.summary.active + '/' + state.sessions.length + ':' + state.summary.tokens_today;
  if (changed && sig !== lastSig) {
    lastSig = sig;
    console.log('[relay] ' + new Date().toISOString() +
      ' active=' + state.summary.active + ' sessions=' + state.sessions.length +
      ' tokensToday=' + state.summary.tokens_today +
      (WALL_URL ? '  →  ' + WALL_URL : ''));
  }
}

if (has('--once')) {
  const s = collect();
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}

server.listen(PORT, BIND, () => {
  console.log('[relay] watching ' + HOME_DIR);
  console.log('[relay] local   http://' + (BIND === '0.0.0.0' ? '<lan-ip>' : BIND) + ':' + PORT + '/api/state');
  console.log(WALL_URL
    ? '[relay] push    ' + WALL_URL + '/api/push'
    : '[relay] (no CLINE_WALL_URL — local mode only)');
});
setInterval(loop, POLL_MS);
loop();
process.on('SIGINT', () => process.exit(0));
