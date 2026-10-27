export class OpenCodeHttpError extends Error {
  readonly name = "OpenCodeHttpError";

  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    readonly html: boolean,
    readonly json = false,
  ) {
    const statusLabel = status === undefined ? "" : ` (HTTP ${status})`;
    super(
      html
        ? `OpenCode ${operation} returned HTML instead of JSON; incompatible OpenCode API${statusLabel}`
        : `OpenCode ${operation} failed${statusLabel}`,
    );
  }
}

export async function checkResponse(response: Response, operation: string): Promise<void> {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const html = mediaType === "text/html";
  if (!response.ok || html) {
    // Classification only: never retain the decoded error body in an exception.
    const inspectJson = response.status === 500 && mediaType === "application/json";
    const json = inspectJson ? await boundedJsonError(response) : false;
    if (!inspectJson) await response.body?.cancel().catch(() => undefined);
    throw new OpenCodeHttpError(operation, response.status, html, json);
  }
}

async function boundedJsonError(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let bytes = 0,
    text = "",
    expired = false;
  // Error diagnostics must not turn a rejected read into an unbounded body wait.
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, 1000);
  try {
    for (;;) {
      const next = await reader.read();
      if (expired) return false;
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65536) return false;
      text += decoder.decode(next.value, { stream: true });
    }
    JSON.parse(text + decoder.decode());
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
