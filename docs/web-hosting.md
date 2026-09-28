# Hosted web app

Build a root-hosted, relay-connected PWA independently of the daemon. Use a fresh
checkout or worktree: never rebuild the checkout that serves a running daemon.

```sh
npm ci --ignore-scripts
npm run postinstall
EXPO_PUBLIC_PASEO_APP_BASE_URL=https://app.example.com \
PASEO_WEB_RELAY_URL=wss://relay.paseo.sh \
PASEO_WEB_NAME=Paseo \
  npm run build:web:hosted --workspace=@getpaseo/app
```

Use the relay origin advertised by the existing daemon. The build does not change
the daemon's relay, auth, listener or origin policy. Hosted builds offer pairing
on the welcome screen and skip automatic localhost discovery. Direct connections
are outside this export's CSP; use a daemon-served or desktop app for that topology.
Native, Electron and ordinary `build:web` exports retain their existing behavior.

Serve `packages/app/dist` over HTTPS. The export includes:

- `hosting.json`: version 1, response `headers` and the exact `immutableAssets`
  allowlist for a static server. Keep this deployment configuration private.
- `_headers`: the equivalent Pages headers, for hosts that understand that format.
- A root-scoped manifest, existing 192/512 icons and Apple touch icon, iOS metadata,
  `register-sw.js`, and a versioned `sw.js`.

Apply the security headers to every response. Default to `Cache-Control: no-cache`;
use a year-long immutable policy only for existing fingerprinted assets. Keep HTML,
the manifest, registration script and service worker revalidated. Fall back to
`index.html` for HTML navigation routes, never for missing assets or `/api`.
Do not expose source maps, deployment configuration or a directory listing.

The CSP permits the explicit relay, same-origin resources, GitHub avatar images
and the exact upstream changelog resource. Dynamic evaluation is required by the
daemon plugin evaluator; inline scripts are hash-authorized, not broadly enabled.
React Native's generated styles require inline styles. Adding another relay or
asset source requires an explicit policy/build change.

## Updates and offline behavior

The service worker caches only the static app shell and named assets. Navigation
is network-first, with its version-matched shell as an offline fallback. API,
cross-origin, non-GET and query-bearing requests pass through without caching.
Host traffic continues directly through the existing encrypted relay.

Updates wait until old windows are closed; there is no forced reload or
`skipWaiting`. Close **all** browser/PWA windows for this origin, then reopen to
activate a waiting release. Activation deletes only older `paseo-shell-*` caches.
Browser-owned host/timeline replicas remain separate from the worker. Opening an
offline shell does not mean an agent can receive work while disconnected.

## Pairing and links

Generate a pairing offer on the intended host:

```sh
env -u PASEO_AGENT_ID -u PASEO_AGENT_CWD paseo daemon pair
```

Open the hosted app and select **Scan QR code** or **Paste pairing link**. Camera
scanning requires HTTPS and camera access; permission is requested only after
opening the scanner. If access was denied, allow the camera in the browser's
site settings and retry. The camera stops on navigation or when the app is hidden.
Unrelated QR codes are ignored. Scanned offers open the same confirmation as
pasted links, with the daemon ID and relay endpoint shown before **Pair** opens
a connection or saves a host. Cancel leaves both untouched. A disconnected camera
stops decoding and offers the existing permission/retry control.
Test iOS home-screen installation separately from Safari tabs.

The web scanner bundles `jsQR` as its fallback when `BarcodeDetector` cannot
decode QR codes. Expo Camera 17's web implementation loads an older jsQR from
a CDN into a module-global worker; using it would require widening the CSP and
would leave that worker outside the scanner's lifetime. Keep decoding local.
The export's existing `media-src 'self' blob:` is sufficient. Hosts that add a
`Permissions-Policy` must allow `camera=(self)` for the top-level app.

An offer generated with
another app-origin prefix is accepted: daemon ID, public key and relay endpoint
are carried in its fragment. Treat the whole offer as private connection material.
The hosted app's **Pair device** links/QR codes use the build's app base URL.
CLI-generated prefixes still use daemon `app.baseUrl`; do not change daemon
configuration merely to move browser origins. Existing evidence links keep their
backend destination.

## Moving browser origins

Pair each host again on the final origin. Workspace pins (`pinnedAt`), project and
workspace records, session history and recent activity are daemon-owned and load
again. A web deployment does not supply Chi capabilities: collaborators still need
the Chi-capable fork daemon and their own host-local GitHub/model authorization.

Origin-local state includes the paired-host registry (`@paseo:daemon-registry`),
client ID, display preferences, custom sidebar order, workspace layouts/open and
pinned agent tabs, last selected workspace and composer drafts (`paseo-drafts`).
IndexedDB contains attachment bytes, directory/timeline replicas and project icon
caches. Pending sends and Chi operation receipts are also origin-local; blindly
copying all browser storage can replay operations or leave attachment references
without their bytes.

Keep the old origin available. Finish or resolve pending sends there; manually
copy important unsent text, reselect mention recipients and reattach files. After
pairing the new origin, confirm pinned workspaces, use **History** to reopen recent
sessions, and restore local ordering/preferences as needed. No automatic import
or clearing of old browser storage is performed.

Install from the final domain: desktop Chrome/Edge's app-install action, Android
Chrome's **Install app**, or iPhone Safari's **Share → Add to Home Screen**. Open the
installed app and check pairing there; do not assume Safari and a home-screen app
share storage on every OS version. Repeat separately for each device/browser.

Verify the deployed origin with desktop and compact browser checks: manifest and
icon dimensions, active/controller service worker, deferred upgrade and scoped
cache cleanup, no CSP/console errors, relay pairing, restored pins/history and
the desired daemon-backed screens. Real-device installation remains a separate
check from a mobile viewport.
