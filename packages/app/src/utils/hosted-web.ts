declare global {
  // eslint-disable-next-line no-var
  var __PASEO_HOSTED_WEB__: unknown;
}

/**
 * True only in a root-hosted export prepared by `scripts/prepare-hosted-web.mjs`,
 * which flags the shell at runtime. Native, Electron and ordinary web builds never
 * set it. A hosted export's CSP permits its configured relay, not arbitrary hosts.
 */
export function isHostedWebExport(): boolean {
  return typeof globalThis !== "undefined" && globalThis.__PASEO_HOSTED_WEB__ === true;
}
