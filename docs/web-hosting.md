# Hosted web app

Build a root-hosted, relay-connected PWA independently of the daemon. Use a fresh
checkout or worktree: never rebuild the checkout that serves a running daemon.

```sh
npm ci
EXPO_PUBLIC_PASEO_APP_BASE_URL=https://app.example.com \
PASEO_WEB_RELAY_URL=wss://relay.paseo.sh \
PASEO_WEB_NAME=Paseo \
  npm run build:web:hosted --workspace=@getpaseo/app
```

`build:web:hosted` validates the inputs, runs the ordinary `build:web` export and
then post-processes `packages/app/dist` with `scripts/prepare-hosted-web.mjs`. The
JavaScript bundle is identical to `build:web`; hosted behaviour is switched on at
runtime by a flag the post-processor injects into `index.html`
(`globalThis.__PASEO_HOSTED_WEB__`). Native, Electron and ordinary `build:web`
exports never set it and keep their existing behaviour.

Use the relay origin advertised by the existing daemon. The build does not change
the daemon's relay, auth, listener or origin policy. Direct connections are outside
this export's CSP, so the hosted welcome screen offers pairing links only; use a
daemon-served or desktop app for direct connections.

Serve `packages/app/dist` over HTTPS. The export adds:

- `hosting.json`: version 1, response `headers` and the exact `immutableAssets`
  allowlist for a static server. Keep this deployment configuration private.
- `_headers`: the equivalent Pages headers, for hosts that understand that format.
- A root-scoped manifest, `register-sw.js` and a versioned `sw.js`.

Apply the security headers to every response. Default to `Cache-Control: no-cache`;
use a year-long immutable policy only for fingerprinted assets. Fall back to
`index.html` for HTML navigation routes, never for missing assets or `/api`.

The CSP permits the explicit relay, same-origin resources, GitHub avatar images
and the upstream changelog. Inline scripts are hash-authorized, not broadly
enabled. Adding another relay or asset source requires a policy/build change.

## Branding

Set `PASEO_WEB_BRAND_DIR` to a directory containing `brand.json` and an `assets/`
folder. The post-processor validates it, copies the icons, rewrites the manifest
and shell, and injects the runtime brand as `globalThis.__PASEO_BRAND__`. Leave it
unset for the default Paseo brand.

`brand.json` carries the app name, the mark (SVG `viewBox` and paths) shown on the
splash and home screens, the working-indicator frames and interval, the
window-title mark, the icon set (manifest icons, apple-touch, favicon and its
status variants) and an optional HTTPS `attribution` link that replaces the
default community links. Unknown fields are ignored. The app reads the injected
value in `packages/app/src/branding`; without it every branded surface renders
exactly as the default app.

## Updates and offline behaviour

The service worker caches only the static app shell and named assets. Navigation
is network-first, with its version-matched shell as an offline fallback. API,
cross-origin, non-GET and query-bearing requests pass through uncached. Relay
traffic is never cached.

Updates are silent. The page revalidates `/sw.js` on launch, on focus/visibility
and hourly. A new worker caches its shell, calls `skipWaiting` and claims open
windows. The page reloads into the new release only while hidden, or once the
user is idle with no editable control focused. Activation deletes only older
`paseo-shell-*` caches.
