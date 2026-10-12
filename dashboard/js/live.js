// Cline live feed — polls /api/cline (served by the Worker, or directly by the
// relay when the frame is pointed at the relay machine on the LAN) and keeps
// window.LIVE fresh for the Cline view.
(function () {
  'use strict';
  var STALE_MS = 120000; // wall shows "stale" if state is older than 2 min
  var POLL_MS = 15000;   // poll cadence — cheap JSON, fine to be chatty

  var LIVE = (window.LIVE = {
    state: null,        // latest parsed state doc (null until first one arrives)
    ok: false,          // is the feed fresh (generated_at within STALE_MS)?
    lastOkAt: null,     // ms epoch of last fresh state
    lastFailAt: null,   // ms epoch of last failed poll
    receivedAt: null    // ms epoch of last accepted state
  });

  function apply(s) {
    if (!s || typeof s !== 'object') return;
    if (!s.generated_at) return; // "waiting for first push" marker
    var age = Date.now() - new Date(s.generated_at).getTime();
    LIVE.state = s;
    LIVE.receivedAt = Date.now();
    if (age < STALE_MS) { LIVE.ok = true; LIVE.lastOkAt = LIVE.receivedAt; }
    else if (!LIVE.ok) { LIVE.lastFailAt = LIVE.receivedAt; }
    App.emit('cline');
  }

  function poll() {
    try {
      var c = new AbortController();
      var t = setTimeout(function () { c.abort(); }, 6000);
      fetch('/api/cline?ts=' + Date.now(), { cache: 'no-store', signal: c.signal })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (s) { if (s) apply(s); })
        .catch(function () {
          if (LIVE.ok) LIVE.ok = false;
          LIVE.lastFailAt = Date.now();
          App.emit('cline');
        })
        .then(function () { clearTimeout(t); });
    } catch (e) { /* no fetch on this browser */ }
  }

  LIVE.poll = poll;
  App.on('ready', poll);
  poll();
  setInterval(poll, POLL_MS);
})();