import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { serviceWorker, serviceWorkerRegistration } from "./service-worker.mjs";

// The generated worker sources live in service-worker.mjs (no top-level await) so
// tests can import the exact strings; re-export keeps one import site for callers.
export { serviceWorker, serviceWorkerRegistration };

// This postprocessor is opt-in: native, Electron and daemon-served builds retain their defaults.
export function hostingConfig(env) {
  const base = new URL(env.EXPO_PUBLIC_PASEO_APP_BASE_URL);
  const relay = new URL(env.PASEO_WEB_RELAY_URL);
  if (
    base.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new Error("EXPO_PUBLIC_PASEO_APP_BASE_URL must be an HTTPS root origin");
  }
  if (
    relay.protocol !== "wss:" ||
    relay.pathname !== "/" ||
    relay.search ||
    relay.hash ||
    relay.username ||
    relay.password
  ) {
    throw new Error("PASEO_WEB_RELAY_URL must be a WSS origin");
  }
  const name = env.PASEO_WEB_NAME || "Paseo";
  if (!/^[\p{L}\p{N} ·_-]{1,40}$/u.test(name)) throw new Error("Invalid PASEO_WEB_NAME");
  return { base: base.origin, relay: relay.origin, name };
}

async function prepare() {
  const config = hostingConfig(process.env);
  if (process.argv.includes("--validate")) return;
  const dist = path.resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
  const files = (await readdir(dist, { recursive: true })).map((file) =>
    file.replaceAll(path.sep, "/"),
  );
  const assets = files
    .filter((file) => /(?:^|[./-])[a-f\d]{16,}\./.test(file))
    .map((file) => `/${file}`);
  const manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
  manifest.name = config.name;
  manifest.short_name = config.name;
  delete manifest.orientation;
  await writeFile(path.join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  let html = await readFile(path.join(dist, "index.html"), "utf8");
  html = html
    .replaceAll('<script src="/register-sw.js" defer></script>', "")
    .replace(/<title>[^<]*<\/title>/, `<title>${config.name}</title>`)
    .replace(/(name="apple-mobile-web-app-title" content=")[^"]*/, `$1${config.name}`)
    .replace("</head>", '<script src="/register-sw.js" defer></script></head>');
  await writeFile(path.join(dist, "index.html"), html);
  await writeFile(path.join(dist, "register-sw.js"), serviceWorkerRegistration());
  const hash = createHash("sha256")
    .update(html)
    .update(JSON.stringify(manifest))
    .update(await readFile(fileURLToPath(import.meta.url)))
    .update(await readFile(fileURLToPath(new URL("./service-worker.mjs", import.meta.url))));
  for (const asset of assets.sort())
    hash.update(asset).update(await readFile(path.join(dist, asset.slice(1))));
  const version = hash.digest("hex").slice(0, 20);
  const initialAssets = [...html.matchAll(/(?:src|href)="(\/[^"?#]+)"/g)].map((match) => match[1]);
  const shell = [
    ...new Set([
      "/index.html",
      "/manifest.json",
      "/apple-touch-icon.png",
      "/pwa-icon-192.png",
      "/pwa-icon-512.png",
      ...initialAssets,
    ]),
  ];
  await writeFile(path.join(dist, "sw.js"), serviceWorker(version, assets, shell));
  const scriptHashes = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`,
  );
  const csp = [
    "default-src 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "manifest-src 'self'",
    `script-src 'self' 'unsafe-eval' ${scriptHashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://avatars.githubusercontent.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    `connect-src 'self' ${config.relay} https://raw.githubusercontent.com/getpaseo/paseo/main/CHANGELOG.md`,
  ].join("; ");
  const headers = {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Cache-Control": "no-cache",
  };
  // A small static server can consume the same policy without implementing Pages' rule syntax.
  await writeFile(
    path.join(dist, "hosting.json"),
    `${JSON.stringify({ version: 1, headers, immutableAssets: assets }, null, 2)}\n`,
  );
  await writeFile(
    path.join(dist, "_headers"),
    `/*\n${Object.entries(headers)
      .map(([name, value]) => `  ${name}: ${value}`)
      .join(
        "\n",
      )}\n\n/_expo/static/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n\n/assets/*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable\n`,
  );
  // Pages' native SPA fallback applies when there is no top-level 404.html.
  if (files.includes("404.html")) throw new Error("Remove 404.html before deploying the SPA");
  console.log(
    `Prepared ${config.name} for ${config.base}; relay ${config.relay}; shell ${version}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepare();
