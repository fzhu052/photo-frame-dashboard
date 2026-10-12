// Cline — live agent wall (mission control for the relay feed, window.LIVE)
(function () {
  'use strict';
  var V = {};
  var PALETTE = [
    { c: '#2D5BFF', rgb: '45 91 255', ink: '#FFFFFF' },
    { c: '#E4007C', rgb: '228 0 124', ink: '#FFFFFF' },
    { c: '#00A36C', rgb: '0 163 108', ink: '#FFFFFF' },
    { c: '#FFB000', rgb: '255 176 0', ink: '#111111' },
    { c: '#7A4AFF', rgb: '122 74 255', ink: '#FFFFFF' },
    { c: '#111111', rgb: '17 17 17', ink: '#FFFFFF' }
  ];
  var STATES = {
    running: { word: 'Running', cls: 'is-running' },
    waiting: { word: 'Waiting', cls: 'is-waiting' },
    idle:    { word: 'Idle',    cls: 'is-idle' },
    done:    { word: 'Done',    cls: 'is-done' },
    error:   { word: 'Failed',  cls: 'is-error' }
  };
  var TASK_COLORS = {
    done: 'var(--ok)', completed: 'var(--ok)', done_review: 'var(--ok)',
    in_progress: 'var(--amber)', running: 'var(--amber)', review: '#7A4AFF',
    failed: 'var(--alert)', error: 'var(--alert)',
    todo: 'var(--mute)', queued: 'var(--mute)', pending: 'var(--mute)'
  };

  function live() { return window.LIVE || { state: null, ok: false, lastOkAt: null, lastFailAt: null }; }

  function colorFor(s) {
    var key = s.agent + '|' + (s.team || '');
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return PALETTE[Math.abs(h) % PALETTE.length];
  }
  function esc(s) { return App.esc(String(s == null ? '' : s)); }
  function fmtDur(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var m = Math.floor(ms / 60000);
    if (m < 1) return Math.floor(ms / 1000) + 's';
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    return h + 'h ' + (m % 60) + 'm';
  }
  function fmtTok(n) {
    n = n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return Math.round(n / 1e3) + 'k';
    return String(n);
  }
  function rel(ts) {
    if (!ts) return '—';
    var t = new Date(ts).getTime();
    return isFinite(t) ? fmtDur(Date.now() - t) + ' ago' : '—';
  }

  function cardHtml(s) {
    var col = colorFor(s);
    var st = STATES[s.state] || STATES.idle;
    var acts = (s.actions || []).slice(0, 3).map(function (a) {
      return '<div class="cl-act"><b>' + esc(a.tool) + '</b><span>' + esc(a.summary) + '</span></div>';
    }).join('');
    var cost = (s.cost_usd != null) ? '<span class="cl-cost num">$' + s.cost_usd.toFixed(2) + '</span>' : '';
    return '<section class="cl-card ' + st.cls + '" style="--c:' + col.c + ';--c-rgb:' + col.rgb + ';--c-ink:' + col.ink + '">' +
      '<header class="cl-head">' +
        '<span class="cl-lamp"></span>' +
        '<div class="cl-id"><b>' + esc(s.agent) + '</b>' +
        (s.team ? '<span class="cl-team">' + esc(s.team) + '</span>' : '') +
        (s.subagent ? '<span class="cl-team cl-sub">sub</span>' : '') +
        '</div>' +
        '<span class="cl-state">' + st.word +
        ((s.state === 'running' || s.state === 'waiting') && s.started_at
          ? ' <span class="cl-elapsed num" data-start="' + esc(s.started_at) + '"></span>' : '') +
        '</span>' +
      '</header>' +
      '<div class="cl-sub">' + esc(s.model) +
      (s.workspace ? '<span class="cl-sep">·</span>' + esc(s.workspace) : '') +
      '</div>' +
      '<div class="cl-acts">' + (acts || '<div class="cl-act cl-act--empty">Waiting for first action…</div>') + '</div>' +
      '<footer class="cl-foot">' +
        '<span class="cl-tok num" title="input / output tokens">' + fmtTok(s.tokens && s.tokens.in) + ' in · ' + fmtTok(s.tokens && s.tokens.out) + ' out</span>' +
        cost +
        '<span class="cl-ago num" data-ago="' + esc(s.last_activity_at || '') + '">' + rel(s.last_activity_at) + '</span>' +
      '</footer>' +
    '</section>';
  }

  function taskRowHtml(t) {
    return '<div class="cl-task"><i style="--ts:' + (TASK_COLORS[t.status] || 'var(--mute)') + '"></i>' +
      '<b>' + esc(t.title) + '</b><span>' + esc((t.status || 'todo').replace(/_/g, ' ')) + '</span></div>';
  }

  function sideHtml(s) {
    var sum = s.summary || {};
    var h = '<div class="cl-sum">' +
      '<div class="label">Today</div>' +
      '<div class="cl-sum-stats">' +
        '<div><span class="num">' + sum.active + '</span><small>active agents</small></div>' +
        '<div><span class="num">' + fmtTok(sum.tokens_today) + '</span><small>tokens</small></div>' +
        '<div><span class="num">' + (sum.cost_today_usd != null ? '$' + sum.cost_today_usd.toFixed(2) : '—') + '</span><small>cost</small></div>' +
        '<div><span class="num">' + sum.sessions_total + '</span><small>sessions</small></div>' +
      '</div>' +
    '</div>';

    if (s.teams && s.teams.length) {
      var t = s.teams[0];
      h += '<div class="cl-side-card">' +
        '<div class="cl-side-head"><span class="label">Team</span><b>' + esc(t.name) + '</b>' +
        (t.members && t.members.length ? '<span class="num cl-dots">' +
          t.members.map(function (m) {
            return '<i class="cl-dot ' + (m.state === 'running' || m.state === 'active' ? 'is-on' : '') + '" title="' + esc(m.id) + ': ' + esc(m.state) + '"></i>';
          }).join('') + '</span>' : '') +
        '</div>' +
        '<div class="cl-tasks">' +
        (t.tasks && t.tasks.length ? t.tasks.map(taskRowHtml).join('') : '<div class="cl-act cl-act--empty">No tasks yet</div>') +
        '</div>' +
      '</div>';
    }
    if (s.schedules && s.schedules.length) {
      h += '<div class="cl-side-card">' +
        '<div class="cl-side-head"><span class="label">Scheduled</span><span class="num cl-count">' + s.schedules.length + '</span></div>' +
        '<div class="cl-tasks">' +
        s.schedules.map(function (x) {
          var on = x.enabled ? 'var(--ok)' : 'var(--mute)';
          return '<div class="cl-task"><i style="--ts:' + on + '"></i><b>' + esc(x.name) + '</b>' +
            '<span>' + (x.last && x.last.at ? rel(x.last.at) : esc(x.cron || '')) + '</span></div>';
        }).join('') +
        '</div>' +
      '</div>';
    }
    return h;
  }

  function fmtUp(sec) {
    sec = Math.max(0, Math.floor(sec));
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm';
    return sec + 's';
  }
  function fmtSizeGb(gb) {
    gb = gb || 0;
    return gb >= 1024 ? (gb / 1024).toFixed(gb >= 10240 ? 0 : 1) + ' TB' : Math.round(gb) + ' GB';
  }
  function tile(key, val, sub, level) {
    return '<div class="cl-tile lv-' + (level || 'ok') + '">' +
      '<span class="cl-tile-key">' + key + '</span><span class="cl-tile-lamp"></span>' +
      '<span class="cl-tile-val num">' + val + '</span>' +
      '<span class="cl-tile-sub">' + sub + '</span></div>';
  }
  function tilesHtml(sys) {
    var h = '';
    var c = sys.cpu;
    if (c) h += tile('cpu_load', c.load[0], c.cores + ' cores · 5m ' + c.load[1], c.level);
    var m = sys.mem;
    if (m) h += tile('memory_pressure', m.free_pct + '% free', fmtSizeGb(Math.round(m.total_mb / 1024)) + ' · ' + fmtSizeGb(Math.round(m.free_mb / 1024)) + ' free', m.level);
    var d = sys.disk;
    if (d) h += tile('disk', d.used_pct + '% used', fmtSizeGb(d.free_gb) + ' free of ' + fmtSizeGb(d.total_gb), d.level);
    if (sys.uptime_s != null) h += tile('uptime', fmtUp(sys.uptime_s), esc(sys.host || ''), 'ok');
    var p = sys.push;
    if (p && p.enabled) {
      h += tile('push', p.ok ? 'ok' : 'fail',
        p.ok ? 'last ok ' + rel(p.last_ok_at) : (p.last_err ? esc(String(p.last_err).slice(0, 30)) : (p.fails || 0) + ' fails'),
        p.level);
    }
    return h;
  }

  function syncEl() {
    var sync = V.el && V.el.querySelector('[data-sync]');
    if (!sync) return;
    var L = live();
    var s = L.state;
    if (!s) { sync.textContent = 'No feed'; sync.className = 'cl-sync-text num'; return; }
    var age = Date.now() - new Date(s.generated_at).getTime();
    if (L.ok) {
      sync.textContent = 'Live · ' + fmtDur(age) + ' old';
      sync.className = 'cl-sync-text num is-live';
    } else {
      sync.textContent = 'Stale · last seen ' + rel(L.lastOkAt);
      sync.className = 'cl-sync-text num is-stale';
    }
  }

  function paint() {
    var el = V.el;
    if (!el || !el.firstChild) return;
    var L = live();
    var s = L.state;
    var root = el.querySelector('.cl');
    if (!s) {
      root.classList.add('is-off');
      el.querySelector('[data-tiles]').innerHTML = '';
      el.querySelector('[data-empty]').innerHTML =
        '<div class="cl-empty-card card">' + App.icon('cline', 44) +
        '<b>No live feed yet</b>' +
        '<span>On the machine that runs Cline, start the relay:<br><code>node relay/index.mjs</code></span>' +
        (L.lastFailAt ? '<small>endpoint not reachable from here</small>' : '<small>waiting for first push…</small>') +
        '</div>';
    } else {
      root.classList.remove('is-off');
      el.querySelector('[data-tiles]').innerHTML = s.system ? tilesHtml(s.system) : '';
      el.querySelector('[data-sessions]').innerHTML = (s.sessions || []).slice(0, 6).map(cardHtml).join('');
      el.querySelector('[data-side]').innerHTML = sideHtml(s);
    }
    syncEl();
  }

  App.on('cline', paint);
  App.on('minute', function () {
    var el = V.el;
    if (!el || !el.firstChild || !el.querySelector('.cl') || !live().state) return;
    el.querySelectorAll('[data-start]').forEach(function (n) {
      var t = new Date(n.getAttribute('data-start')).getTime();
      if (isFinite(t)) n.textContent = '· ' + fmtDur(Date.now() - t);
    });
    el.querySelectorAll('[data-ago]').forEach(function (n) {
      n.textContent = rel(n.getAttribute('data-ago'));
    });
    syncEl();
  });

  App.register('cline', {
    show: function (el) {
      V.el = el;
      if (!el.firstChild) {
        el.innerHTML =
          '<div class="cl">' +
            '<header class="cl-top">' +
              '<div><div class="label">Cline · live</div><h1>Cline</h1></div>' +
              '<div class="cl-sync">' +
                '<span class="cl-sync-text num" data-sync>Connecting…</span>' +
                '<button class="icon-btn" data-refresh aria-label="Refresh feed">' + App.icon('left', 24) + '</button>' +
              '</div>' +
            '</header>' +
            '<div class="cl-tiles" data-tiles></div>' +
            '<div class="cl-body">' +
              '<div class="cl-sessions" data-sessions></div>' +
              '<aside class="cl-side" data-side></aside>' +
            '</div>' +
            '<div class="cl-empty" data-empty></div>' +
          '</div>';
        el.querySelector('[data-refresh]').addEventListener('click', function () {
          if (live().poll) live().poll();
        });
      }
      paint();
    },
    resume: function () {
      var p = live().poll;
      if (p) p();
    }
  });
})();