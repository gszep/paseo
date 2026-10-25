import { isCancel, password } from "@clack/prompts";
import type { Readable } from "node:stream";

/** Operator-owned secret input: never a command-line argument or echoed value. */
export async function readPrivateInput(
  options: { stdin?: unknown; secret?: unknown },
  input: Readable & { isTTY?: boolean } = process.stdin,
): Promise<string> {
  if (Boolean(options.stdin) === Boolean(options.secret))
    throw new Error("Choose exactly one of --stdin or --secret");
  if (options.secret) {
    if (!input.isTTY)
      throw new Error("--secret requires a private interactive terminal; use --stdin for a pipe");
    let value: string | symbol;
    try {
      value = await password({ message: "Private value (not displayed or logged)" });
    } catch {
      throw new Error("Private terminal input failed");
    }
    if (isCancel(value)) throw new Error("Private input cancelled");
    if (!value || Buffer.byteLength(value) > 65536)
      throw new Error("Private input must contain 1–65536 bytes");
    return value;
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of input) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 65536) throw new Error();
      chunks.push(buffer);
    }
    const value = new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.concat(chunks))
      .replace(/\r?\n$/, "");
    if (!value.length) throw new Error();
    return value;
  } catch {
    throw new Error("Private stdin must contain 1–65536 bytes of valid UTF-8");
  }
}
