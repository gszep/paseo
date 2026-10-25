import { afterEach, expect, test, vi } from "vitest";
import { Readable } from "node:stream";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { readPrivateInput } from "../../utils/private-input.js";
import { verifyDeepgramCredentials } from "./credentials.js";

const { prompt } = vi.hoisted(() => ({ prompt: vi.fn() }));
vi.mock("@clack/prompts", () => ({
  password: prompt,
  isCancel: (value: unknown) => typeof value === "symbol",
}));

const homes: string[] = [];
afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const cli = fileURLToPath(new URL("../../../dist/index.js", import.meta.url));
function run(directory: string, args: string[], input?: string | Buffer) {
  return spawnSync(process.execPath, [cli, ...args, "--home", directory, "--json"], {
    input,
    encoding: "utf8",
    timeout: 10_000,
    env: { HOME: directory, PATH: process.env.PATH },
  });
}
function home() {
  const value = mkdtempSync(join(tmpdir(), "speech-private-input-"));
  homes.push(value);
  return value;
}

test("stdin binding uses private atomic config only, preserves other settings, and does not start or reload a daemon", () => {
  const root = home();
  expect(
    run(root, ["daemon", "config", "set", "features.dictation.stt.language", "multi", "--no-apply"])
      .status,
  ).toBe(0);
  const before = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  const key = "fixture-private-canary";
  const set = run(
    root,
    ["daemon", "config", "set", "providers.deepgram.apiKey", "--stdin", "--string", "--no-apply"],
    key,
  );
  expect(set.status).toBe(0);
  expect(set.stdout + set.stderr).not.toContain(key);
  expect(JSON.parse(set.stdout)).toMatchObject({ action: "saved", applied: false });
  const after = JSON.parse(readFileSync(join(root, "config.json"), "utf8"));
  expect(after).toEqual({
    ...before,
    providers: { ...before.providers, deepgram: { apiKey: key } },
  });
  if (process.platform !== "win32")
    expect(statSync(join(root, "config.json")).mode & 0o777).toBe(0o600);
  expect(readdirSync(root)).toEqual(["config.json"]);
  const status = run(root, ["speech", "credentials", "status", "--provider", "deepgram"]);
  expect(status.status).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({
    present: true,
    accepted: null,
    source: "configured",
    speechPermissionsVerified: false,
  });
  expect(status.stdout + status.stderr).not.toContain(key);
  const get = run(root, ["daemon", "config", "get", "providers.deepgram.apiKey"]);
  expect(JSON.parse(get.stdout)).toMatchObject({ set: true, value: "[redacted]" });
}, 45_000); // Four real CLI processes, each bounded to 10s, sharing one config fixture.

test("prospective-key status is presence only, never saves or contacts the provider", () => {
  const root = home();
  const result = run(
    root,
    ["speech", "credentials", "status", "--provider", "deepgram", "--stdin"],
    "fixture-canary",
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    present: true,
    accepted: null,
    source: "stdin",
  });
  expect(result.stdout + result.stderr).not.toContain("fixture-canary");
  expect(readdirSync(root)).toEqual([]);
}, 15_000);

test("private-input misuse and validation errors do not echo input or create files", () => {
  const root = home();
  const invalid = run(
    root,
    ["daemon", "config", "set", "features.voiceMode.tts.provider", "--stdin", "--no-apply"],
    "fixture-secret-invalid-provider",
  );
  expect(invalid.status).not.toBe(0);
  expect(invalid.stdout + invalid.stderr).not.toContain("fixture-secret-invalid-provider");
  const mixed = run(
    root,
    [
      "daemon",
      "config",
      "set",
      "providers.deepgram.apiKey",
      "fixture-argv",
      "--stdin",
      "--no-apply",
    ],
    "fixture-stdin",
  );
  expect(mixed.status).not.toBe(0);
  expect(mixed.stdout + mixed.stderr).not.toMatch(/fixture-argv|fixture-stdin/);
  expect(readdirSync(root)).toEqual([]);
}, 25_000);

test("private input rejects empty, oversized, malformed UTF-8 and noninteractive prompt use", async () => {
  for (const value of [Buffer.alloc(0), Buffer.alloc(65537), Buffer.from([0xff])])
    await expect(readPrivateInput({ stdin: true }, Readable.from([value]))).rejects.toThrow(
      "Private stdin",
    );
  await expect(readPrivateInput({ secret: true }, Readable.from([]))).rejects.toThrow(
    "private interactive terminal",
  );
  await expect(readPrivateInput({ stdin: true, secret: true }, Readable.from([]))).rejects.toThrow(
    "exactly one",
  );
});

test("presence checks and private updates sanitize malformed configuration errors", () => {
  const root = home();
  const malformed = '{"providers":{"deepgram":{"apiKey":"fixture-private-canary"}}';
  writeFileSync(join(root, "config.json"), malformed, { mode: 0o600 });
  const status = run(root, ["speech", "credentials", "status", "--provider", "deepgram"]);
  expect(status.status).not.toBe(0);
  expect(status.stdout + status.stderr).not.toContain("fixture-private-canary");
  const set = run(
    root,
    ["daemon", "config", "set", "providers.deepgram.apiKey", "--stdin", "--no-apply"],
    "fixture-new-canary",
  );
  expect(set.status).not.toBe(0);
  expect(set.stdout + set.stderr).not.toMatch(/fixture-private-canary|fixture-new-canary/);
  expect(readFileSync(join(root, "config.json"), "utf8")).toBe(malformed);
}, 25_000);

test("private terminal entry uses the existing masked prompt and cancellation does not return a value", async () => {
  const terminal = Object.assign(Readable.from([]), { isTTY: true });
  prompt.mockResolvedValueOnce("fixture-secret");
  expect(await readPrivateInput({ secret: true }, terminal)).toBe("fixture-secret");
  expect(prompt).toHaveBeenCalledWith({ message: "Private value (not displayed or logged)" });
  prompt.mockResolvedValueOnce(Symbol("cancel"));
  await expect(readPrivateInput({ secret: true }, terminal)).rejects.toThrow("cancelled");
  prompt.mockResolvedValueOnce("");
  await expect(readPrivateInput({ secret: true }, terminal)).rejects.toThrow("Private input");
  prompt.mockResolvedValueOnce(undefined);
  await expect(readPrivateInput({ secret: true }, terminal)).rejects.toThrow("Private input");
  prompt.mockRejectedValueOnce(new Error("fixture-private-canary"));
  await expect(readPrivateInput({ secret: true }, terminal)).rejects.toThrow(
    /^Private terminal input failed$/,
  );
});

test.each([
  [200, true],
  [401, false],
  [403, null],
  [429, null],
  [503, null],
] as const)(
  "explicit management-only verification returns nonsecret acceptance for HTTP %i",
  async (status, accepted) => {
    const response = new Response('{"private":"must not be read"}', { status });
    const cancel = vi.spyOn(response.body!, "cancel");
    const text = vi.spyOn(response, "text");
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await verifyDeepgramCredentials("fixture-key", request)).toEqual({
      present: true,
      accepted,
    });
    expect(request).toHaveBeenCalledWith(
      "https://api.deepgram.com/v1/projects",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: { Authorization: "Token fixture-key" },
      }),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
  },
);

test("missing key skips network and transport failure cannot leak key-bearing errors", async () => {
  const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("fixture-private-canary"));
  expect(await verifyDeepgramCredentials(undefined, request)).toEqual({
    present: false,
    accepted: null,
  });
  expect(request).not.toHaveBeenCalled();
  expect(await verifyDeepgramCredentials("fixture-private-canary", request)).toEqual({
    present: true,
    accepted: null,
  });
  expect(request).toHaveBeenCalledTimes(1);
});
