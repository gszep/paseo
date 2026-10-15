// Run after installing this source tree's seven npm packs into a fresh prefix.
// No native service, provider, real credentials, or installed host is used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const prefix = await realpath(process.argv[2]);
const source = fileURLToPath(new URL("../../../", import.meta.url));
assert.notEqual(prefix, await realpath(source));
const server = join(prefix, "node_modules/@getpaseo/server");
const require = createRequire(join(server, "package.json"));
const helperEntry = require.resolve("@henkaku-center/chi-native/append-client");
assert.ok(helperEntry.startsWith(server + "/node_modules/@henkaku-center/chi-native/"));
const manifest = JSON.parse(
  await readFile(join(server, "node_modules/@henkaku-center/chi-native/package.json")),
);
assert.equal(manifest.version, "0.0.0");
const archive = join(source, "vendor/henkaku-center-chi-native-0.0.0.tgz");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.equal(
  sha(await readFile(archive)),
  "14a3dd71de3de4da7d0c7e5990f6670736244930ea5931a684aed19bea17bddb",
);
const scratch = await mkdtemp(join(tmpdir(), "flat-inbox-packed-"));
async function inventory(root, path = root) {
  const rows = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    assert.equal(entry.isSymbolicLink(), false);
    if (entry.isDirectory()) rows.push(...(await inventory(root, child)));
    else rows.push([child.slice(root.length + 1), sha(await readFile(child))]);
  }
  return rows.sort(([a], [b]) => a.localeCompare(b));
}
let http;
try {
  // Hash checked above: extract only this reviewed archive, not caller tar data.
  execFileSync("/usr/bin/tar", ["-xzf", archive, "-C", scratch], { timeout: 10000 });
  const expected = await inventory(join(scratch, "package"));
  assert.equal(expected.length, 53);
  assert.deepEqual(
    await inventory(join(server, "node_modules/@henkaku-center/chi-native")),
    expected,
  );
  const helper = await import(pathToFileURL(helperEntry));
  assert.equal("isAppendHttp503Reason" in helper, false);
  assert.equal(typeof helper.AppendClient, "function");
  const { ChiConnection } = await import(
    pathToFileURL(join(server, "dist/server/server/chi/connection.js"))
  );
  const { ChiMentions } = await import(
    pathToFileURL(join(server, "dist/server/server/chi/mentions.js"))
  );
  assert.equal(typeof ChiConnection, "function");
  const { parseServerInfoStatusPayload } = await import(
    pathToFileURL(require.resolve("@getpaseo/protocol/messages"))
  );
  assert.equal(
    parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv-fixture",
      features: { chiDeploymentInbox: true },
    })?.features?.chiDeploymentInbox,
    true,
  );
  const calls = [];
  let status = 200,
    body;
  http = createServer((request, response) => {
    calls.push({ method: request.method, url: request.url, repo: request.headers["x-chi-repo"] });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const mentions = new ChiMentions(scratch, {
    endpoint: `http://127.0.0.1:${http.address().port}`,
    request: fetch,
  });
  const identity = { repo: "*", actor: "github:reader", token: "fixture", deployment: "fixture" };
  const pin = (repo) => ({
    v: 3,
    deployment: "fixture",
    repo,
    sourceId: "a".repeat(64),
    count: 1,
    head: "b".repeat(64),
  });
  body = {
    handoffs: ["github:fixture/one", "github:fixture/two"].map((repo, index) => ({
      v: 3,
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      repo,
      author: "github:author",
      recipient: identity.actor,
      text: "Synthetic already-read evidence",
      sources: [{ pin: pin(repo), seq: 0 }],
      state: "open",
      revision: 1,
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      readAt: "2026-10-01T00:00:00Z",
      events: [],
    })),
    nextCursor: "next",
    unreadCount: 0,
    unreadCountLowerBound: false,
  };
  const result = await mentions.execute(identity, {
    action: "inbox",
    inbox: true,
    cursor: "opaque",
  });
  assert.equal(result.kind, "inbox");
  assert.deepEqual(
    result.handoffs.map((row) => row.repo),
    ["github:fixture/one", "github:fixture/two"],
  );
  assert.deepEqual(
    result.handoffs.map((row) => row.sources[0].appendRef),
    body.handoffs.map((row) => row.sources[0]),
  );
  assert.equal(result.nextCursor, "next");
  assert.deepEqual(calls, [
    { method: "GET", url: "/handoffs/inbox?inbox=received&cursor=opaque", repo: undefined },
  ]);
  status = 503;
  body = { ok: false, reason: "deployment-inbox-not-ready" };
  await assert.rejects(
    mentions.execute(identity, { action: "inbox", inbox: true }),
    /chi-mentions-http-503-deployment-inbox-not-ready/,
  );
  body = { ok: false, reason: "private-diagnostic" };
  await assert.rejects(
    mentions.execute(identity, { action: "inbox", inbox: true }),
    (error) => error.message === "chi-mentions-http-503",
  );
  status = 403;
  await assert.rejects(
    mentions.execute(identity, { action: "inbox", inbox: true }),
    (error) => error.message === "chi-mentions-http-403",
  );
  assert.ok(
    calls.every(
      (call) =>
        call.method === "GET" && call.url.startsWith("/handoffs/inbox?") && call.repo === undefined,
    ),
  );
  console.log(
    JSON.stringify({
      helperFiles: 53,
      helperUnchanged: true,
      realLoader: true,
      deploymentProtocol: true,
      crossRepositoryPage: true,
      catalogReads: 0,
      writes: 0,
    }),
  );
} finally {
  if (http) await new Promise((resolve) => http.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
