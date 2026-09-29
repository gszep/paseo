import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
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

const BRAND_NAME_PATTERN = /^[\p{L}\p{N} ·_-]{1,40}$/u;
const BRAND_HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

function assertAssetName(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(value) || value.includes("..")) {
    throw new Error(`Invalid brand asset name for ${label}`);
  }
  return value;
}

function parseBrandFaviconSet(value, label) {
  if (typeof value !== "object" || value === null) throw new Error(`Invalid ${label}`);
  const out = {};
  for (const status of ["none", "running", "attention"]) {
    out[status] = assertAssetName(value[status], `${label}.${status}`);
  }
  return out;
}

/**
 * Validates the brand inputs consumed by the hosted build. Kept pure so tests
 * can exercise it without a filesystem.
 */
export function parseBrandJson(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("brand.json must be an object");
  const { name, mark, workingIndicator, titleMark, icons, attribution } = raw;
  if (typeof name !== "string" || !BRAND_NAME_PATTERN.test(name)) {
    throw new Error("Invalid brand name");
  }
  if (titleMark !== null && titleMark !== undefined && typeof titleMark !== "string") {
    throw new Error("Invalid brand titleMark");
  }
  if (typeof titleMark === "string" && (titleMark.length === 0 || titleMark.length > 8)) {
    throw new Error("Invalid brand titleMark");
  }
  return {
    name,
    mark: parseBrandMark(mark),
    workingIndicator: parseWorkingIndicatorInput(workingIndicator),
    titleMark: typeof titleMark === "string" ? titleMark : null,
    icons: parseBrandIcons(icons),
    attribution: parseAttributionInput(attribution),
  };
}

function parseBrandMark(mark) {
  if (typeof mark !== "object" || mark === null) throw new Error("Invalid brand mark");
  if (typeof mark.viewBox !== "string" || mark.viewBox.length === 0 || mark.viewBox.length > 80) {
    throw new Error("Invalid brand mark viewBox");
  }
  if (!Array.isArray(mark.paths) || mark.paths.length === 0 || mark.paths.length > 8) {
    throw new Error("Invalid brand mark paths");
  }
  for (const d of mark.paths) {
    if (typeof d !== "string" || d.length === 0 || d.length > 20000) {
      throw new Error("Invalid brand mark path");
    }
  }
  return { viewBox: mark.viewBox, paths: mark.paths };
}

function parseWorkingIndicatorInput(workingIndicator) {
  if (workingIndicator === null || workingIndicator === undefined) return null;
  if (typeof workingIndicator !== "object") throw new Error("Invalid brand workingIndicator");
  if (
    !Array.isArray(workingIndicator.frames) ||
    workingIndicator.frames.length === 0 ||
    workingIndicator.frames.length > 32 ||
    workingIndicator.frames.some((f) => typeof f !== "string" || f.length === 0 || f.length > 8)
  ) {
    throw new Error("Invalid brand workingIndicator frames");
  }
  if (
    !Number.isInteger(workingIndicator.intervalMs) ||
    workingIndicator.intervalMs < 16 ||
    workingIndicator.intervalMs > 5000
  ) {
    throw new Error("Invalid brand workingIndicator intervalMs");
  }
  return { frames: workingIndicator.frames, intervalMs: workingIndicator.intervalMs };
}

function parseBrandIcons(icons) {
  if (icons === null || icons === undefined) return null;
  if (typeof icons !== "object") throw new Error("Invalid brand icons");
  if (!BRAND_HEX_PATTERN.test(icons.themeColor ?? "")) throw new Error("Invalid themeColor");
  if (!BRAND_HEX_PATTERN.test(icons.backgroundColor ?? ""))
    throw new Error("Invalid backgroundColor");
  if (!Array.isArray(icons.manifest) || icons.manifest.length === 0) {
    throw new Error("Invalid brand manifest icons");
  }
  const manifest = icons.manifest.map((icon, index) => {
    if (typeof icon !== "object" || icon === null) throw new Error("Invalid manifest icon");
    if (typeof icon.sizes !== "string" || !/^\d+x\d+$/.test(icon.sizes)) {
      throw new Error(`Invalid manifest icon sizes at ${index}`);
    }
    assertAssetName(icon.src, `manifest.${index}.src`);
    return {
      src: icon.src,
      sizes: icon.sizes,
      type: typeof icon.type === "string" ? icon.type : "image/png",
      purpose: typeof icon.purpose === "string" ? icon.purpose : "any",
    };
  });
  return {
    themeColor: icons.themeColor,
    backgroundColor: icons.backgroundColor,
    appleTouch: assertAssetName(icons.appleTouch, "appleTouch"),
    favicon: assertAssetName(icons.favicon, "favicon"),
    faviconPng: {
      light: assertAssetName(icons.faviconPng?.light, "faviconPng.light"),
      dark: assertAssetName(icons.faviconPng?.dark, "faviconPng.dark"),
    },
    faviconStates: {
      light: parseBrandFaviconSet(icons.faviconStates?.light, "faviconStates.light"),
      dark: parseBrandFaviconSet(icons.faviconStates?.dark, "faviconStates.dark"),
    },
    manifest,
  };
}

function parseAttributionInput(attribution) {
  if (attribution === null || attribution === undefined) return null;
  if (typeof attribution !== "object") throw new Error("Invalid brand attribution");
  const { label, url } = attribution;
  if (
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.length > 60 ||
    [...label].some((char) => char.charCodeAt(0) < 0x20)
  ) {
    throw new Error("Invalid brand attribution label");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid brand attribution url");
  }
  if (parsed.protocol !== "https:") throw new Error("Brand attribution url must be HTTPS");
  return { label: label.trim(), url };
}

/** Reads and validates `brand.json` from the given directory, or null when unset. */
export async function readBrand(dir) {
  if (!dir) return null;
  const raw = JSON.parse(await readFile(path.join(dir, "brand.json"), "utf8"));
  return parseBrandJson(raw);
}

/** Every asset filename the brand references, so the build knows what to copy. */
export function brandAssetNames(brand) {
  if (!brand?.icons) return [];
  const names = new Set([
    brand.icons.appleTouch,
    brand.icons.favicon,
    brand.icons.faviconPng.light,
    brand.icons.faviconPng.dark,
  ]);
  for (const scheme of ["light", "dark"]) {
    for (const status of ["none", "running", "attention"]) {
      names.add(brand.icons.faviconStates[scheme][status]);
    }
  }
  for (const icon of brand.icons.manifest) names.add(icon.src);
  return [...names];
}

/** The subset of the brand the app reads at runtime; null restores the default. */
export function brandRuntimeConfig(brand) {
  if (!brand) return null;
  const faviconUrl = (scheme, status) => `/brand/${brand.icons.faviconStates[scheme][status]}`;
  return {
    name: brand.name,
    mark: brand.mark,
    workingIndicator: brand.workingIndicator,
    titleMark: brand.titleMark,
    favicons: brand.icons
      ? {
          light: {
            none: faviconUrl("light", "none"),
            running: faviconUrl("light", "running"),
            attention: faviconUrl("light", "attention"),
          },
          dark: {
            none: faviconUrl("dark", "none"),
            running: faviconUrl("dark", "running"),
            attention: faviconUrl("dark", "attention"),
          },
        }
      : null,
    attribution: brand.attribution,
  };
}

function escapeInlineJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** Rewrites the exported manifest with the brand name, colours and icons. */
export function applyBrandToManifest(manifest, brand) {
  if (!brand) return manifest;
  const next = { ...manifest, name: brand.name, short_name: brand.name };
  if (brand.icons) {
    next.theme_color = brand.icons.themeColor;
    next.background_color = brand.icons.backgroundColor;
    next.icons = brand.icons.manifest.map((icon) => ({
      src: `/brand/${icon.src}`,
      sizes: icon.sizes,
      type: icon.type,
      purpose: icon.purpose,
    }));
  }
  return next;
}

/** Rewrites the exported shell's name, icons and injected runtime brand. */
export function applyBrandToHtml(html, brand) {
  let next = html;
  if (brand?.name) {
    next = next
      .replace(/<title>[^<]*<\/title>/, `<title>${brand.name}</title>`)
      .replace(/(name="apple-mobile-web-app-title" content=")[^"]*/, `$1${brand.name}`);
  }
  const extras = [];
  if (brand?.icons) {
    next = next
      .replace(
        /<meta name="theme-color" content="[^"]*" \/>/,
        `<meta name="theme-color" content="${brand.icons.themeColor}" />`,
      )
      .replace(
        /<link rel="apple-touch-icon" href="[^"]*" \/>/,
        `<link rel="apple-touch-icon" href="/brand/${brand.icons.appleTouch}" />`,
      );
    extras.push(
      [
        `<link rel="icon" href="/brand/${brand.icons.favicon}" sizes="any" />`,
        `<link rel="icon" type="image/png" media="(prefers-color-scheme: light)" href="/brand/${brand.icons.faviconPng.light}" />`,
        `<link rel="icon" type="image/png" media="(prefers-color-scheme: dark)" href="/brand/${brand.icons.faviconPng.dark}" />`,
      ].join(""),
    );
  }
  if (brand) {
    extras.push(
      `<script>globalThis.__PASEO_BRAND__=${escapeInlineJson(brandRuntimeConfig(brand))}</script>`,
    );
  }
  extras.push('<script src="/register-sw.js" defer></script>');
  return next.replace("</head>", `${extras.join("")}</head>`);
}

async function prepare() {
  const config = hostingConfig(process.env);
  const brand = await readBrand(process.env.PASEO_WEB_BRAND_DIR);
  if (process.argv.includes("--validate")) return;
  const dist = path.resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
  if (brand?.icons) {
    const brandDir = process.env.PASEO_WEB_BRAND_DIR;
    await mkdir(path.join(dist, "brand"), { recursive: true });
    await Promise.all(
      brandAssetNames(brand).map((name) =>
        copyFile(path.join(brandDir, "assets", name), path.join(dist, "brand", name)),
      ),
    );
    // Browsers fall back to /favicon.ico when a link is missing; keep it on-brand too.
    await copyFile(
      path.join(brandDir, "assets", brand.icons.favicon),
      path.join(dist, "favicon.ico"),
    ).catch(() => undefined);
  }
  const files = (await readdir(dist, { recursive: true })).map((file) =>
    file.replaceAll(path.sep, "/"),
  );
  const assets = files
    .filter((file) => /(?:^|[./-])[a-f\d]{16,}\./.test(file))
    .map((file) => `/${file}`);
  let manifest = JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
  manifest = applyBrandToManifest(manifest, brand);
  if (!brand) {
    manifest.name = config.name;
    manifest.short_name = config.name;
  }
  delete manifest.orientation;
  await writeFile(path.join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  let html = (await readFile(path.join(dist, "index.html"), "utf8")).replaceAll(
    '<script src="/register-sw.js" defer></script>',
    "",
  );
  html = brand
    ? applyBrandToHtml(html, brand)
    : html
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
  const brandShell = brand?.icons
    ? brandAssetNames(brand).map((name) => `/brand/${name}`)
    : ["/apple-touch-icon.png", "/pwa-icon-192.png", "/pwa-icon-512.png"];
  const shell = [...new Set(["/index.html", "/manifest.json", ...brandShell, ...initialAssets])];
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
