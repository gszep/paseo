import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { killProcessTree } from "./spawn-node";

/** Run the production Cloudflare relay locally, without its deployment cutover upstream. */
export async function startLocalWorkerRelay() {
  const reservation = net.createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing relay port");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const child = spawn(
    process.execPath,
    [
      path.join(path.dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js"),
      "dev",
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--var",
      "PASEO_RELAY_UPSTREAM:",
      "--live-reload=false",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: path.resolve(__dirname, "../../../../relay"),
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-8000);
  });
  child.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-8000);
  });
  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Relay exited: ${output}`);
      try {
        await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
        return { endpoint: `127.0.0.1:${port}`, close: () => killProcessTree(child) };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`Relay startup timed out: ${output}`);
  } catch (error) {
    await killProcessTree(child);
    throw error;
  }
}
