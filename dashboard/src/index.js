// ---------------------------------------------------------------------------
// Home dashboard — hybrid Cloudflare Worker
//
// Serves Wes's static dashboard (assets binding) plus two live-state endpoints
// for the Cline status wall:
//
//   GET  /api/cline  → latest state doc from the R2 bucket "CLINE"
//   PUT  /api/push   → relay push (Bearer $CLINE_SECRET), stored in R2
//
// Deploy:  wrangler deploy          (run `wrangler r2 bucket create cline-state`
//           once first — the bucket name must match wrangler.jsonc)
// ---------------------------------------------------------------------------
const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'access-control-allow-origin': '*',
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export default {
  async fetch(request, env) {
    const p = new URL(request.url).pathname;

    if (p === '/api/cline') {
      if (!env.CLINE) {
        return json({ v: 1, offline: true, message: 'R2 bucket "CLINE" not bound — set r2_buckets in wrangler.jsonc and run: wrangler r2 bucket create cline-state' });
      }
      const obj = await env.CLINE.get('state.json');
      if (!obj) {
        return json({ v: 1, offline: true, message: 'No state yet. On the machine that runs Cline: node relay/index.mjs --once  (or let the relay push on its own.)' });
      }
      return new Response(await obj.text(), { headers: JSON_HEADERS });
    }

    if (p === '/api/push' && (request.method === 'POST' || request.method === 'PUT')) {
      // When CLINE_SECRET is set, the relay must send "Authorization: Bearer <secret>".
      // (Left unset = dev mode with no auth — never do that on a public deployment.)
      if (env.CLINE_SECRET) {
        const auth = request.headers.get('authorization') || '';
        if (auth !== 'Bearer ' + env.CLINE_SECRET) return json({ error: 'forbidden' }, 403);
      }
      const len = Number(request.headers.get('content-length') || 0);
      if (len > 2 * 1024 * 1024) return json({ error: 'payload too large' }, 413);
      const body = await request.text();
      try { JSON.parse(body); } catch { return json({ error: 'invalid json' }, 400); }
      if (!env.CLINE) return json({ error: 'r2 bucket not bound' }, 501);
      await env.CLINE.put('state.json', body);
      return json({ ok: true });
    }

    return env.ASSETS.fetch(request);
  },
};