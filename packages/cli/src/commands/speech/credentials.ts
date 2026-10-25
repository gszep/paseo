import { readPersistedConfig, resolveDeepgramApiKey } from "@getpaseo/server/configuration";
import { readPrivateInput } from "../../utils/private-input.js";
import type { CommandOptions } from "../../output/index.js";

/** Management authentication only: no audio/model request, key creation or purchase. */
export async function verifyDeepgramCredentials(
  key: string | undefined,
  request: typeof fetch = fetch,
): Promise<{ present: boolean; accepted: boolean | null }> {
  if (!key) return { present: false, accepted: null };
  try {
    const response = await request("https://api.deepgram.com/v1/projects", {
      method: "GET",
      headers: { Authorization: `Token ${key}` },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel(); // Do not parse, retain or print account/project data.
    let accepted: boolean | null = null;
    if (response.status === 200) accepted = true;
    if (response.status === 401) accepted = false;
    return { present: true, accepted };
  } catch {
    return { present: true, accepted: null };
  }
}

export async function speechCredentialStatus(options: CommandOptions, verify: boolean) {
  let key: string | undefined;
  let source: string;
  if (options.stdin || options.secret) {
    key = (await readPrivateInput({ stdin: options.stdin, secret: options.secret })).trim();
    if (!key) throw new Error("Private credential input cannot be empty");
    source = options.stdin ? "stdin" : "private-prompt";
  } else {
    if (options.daemonTarget.kind !== "instance")
      throw new Error("Credential checks require --home");
    try {
      const persisted = readPersistedConfig(options.daemonTarget.home);
      key = resolveDeepgramApiKey(persisted, process.env);
      source = "missing";
      if (key) source = "cli-process-environment";
      if (persisted.providers?.deepgram?.apiKey?.trim()) source = "configured";
    } catch {
      throw new Error("Could not read local credential configuration; inspect it privately");
    }
  }
  const verification = verify
    ? await verifyDeepgramCredentials(key)
    : { present: Boolean(key), accepted: null };
  let message = "Credential presence only; authentication not checked";
  if (verify) {
    message = "Management API authentication inconclusive; no additional permission is requested";
    if (!verification.present) message = "No credential supplied";
    if (verification.accepted === true) message = "MANAGEMENT API authentication accepted";
    if (verification.accepted === false) message = "Management API authentication rejected";
  }
  const data = {
    provider: "deepgram",
    source,
    scope: "CLI check only; running daemon binding is not verified",
    ...verification,
    message,
    speechPermissionsVerified: false,
  };
  return {
    type: "single" as const,
    data,
    schema: {
      idField: () => "deepgram",
      columns: [],
      renderHuman: () => JSON.stringify(data, null, 2),
    },
  };
}
