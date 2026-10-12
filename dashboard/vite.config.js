import { defineConfig } from 'vite';

// The wall tablet runs Android WebView 106 — keep JS output within Chromium 106.
// CSS targets chrome61 on purpose: the tablet's WebView rejects 4/8-digit hex colours (#0000,
// #ffffffbf) even though Chrome 106 should support them, and a newer target lets the minifier
// rewrite transparent/rgba() into that form. Verified on-device with CSS.supports().
export default defineConfig({
  build: {
    target: 'chrome106',
    cssTarget: 'chrome61',
  },
  server: {
    host: true,
    // Dev-only: /api/* → local `wrangler dev` (worker + emulated R2). In
    // production the worker itself serves both the static files and /api/*.
    proxy: {
      '/api': process.env.CLINE_API_PROXY || 'http://127.0.0.1:8790',
    },
  },
});
