import { createHash } from "node:crypto";

interface ErrorResponseMetadata {
  mediaType: "application/json" | "text/html" | "text/plain" | "other" | "missing";
  bytes: number;
  eof: boolean;
  parsedJson: boolean;
  sha256: string | null;
  errorCode:
    | "UnknownError"
    | "ServiceUnavailableError"
    | "PermissionNotFoundError"
    | "FormNotFoundError"
    | null;
}

export class OpenCodeHttpError extends Error {
  readonly name = "OpenCodeHttpError";

  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    readonly html: boolean,
    readonly json = false,
    readonly responseMetadata?: ErrorResponseMetadata,
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
    const permissionFailure =
      response.status === 500 && /^\/api\/session\/[^/]+\/(permission|form)$/.test(operation);
    const inspect =
      response.status === 500 && (mediaType === "application/json" || permissionFailure);
    const body = inspect ? await boundedErrorMetadata(response) : undefined;
    const json = mediaType === "application/json" && body?.parsedJson === true;
    if (!inspect) await response.body?.cancel().catch(() => undefined);
    const responseMetadata =
      permissionFailure && body ? { mediaType: safeMediaType(mediaType), ...body } : undefined;
    throw new OpenCodeHttpError(operation, response.status, html, json, responseMetadata);
  }
}

function safeMediaType(value: string | undefined): ErrorResponseMetadata["mediaType"] {
  switch (value) {
    case "application/json":
    case "text/html":
    case "text/plain":
      return value;
    case undefined:
    case "":
      return "missing";
    default:
      return "other";
  }
}

async function boundedErrorMetadata(
  response: Response,
): Promise<Omit<ErrorResponseMetadata, "mediaType">> {
  const result: Omit<ErrorResponseMetadata, "mediaType"> = {
    bytes: 0,
    eof: false,
    parsedJson: false,
    sha256: null,
    errorCode: null,
  };
  const hash = createHash("sha256");
  const reader = response.body?.getReader();
  if (!reader) return { ...result, eof: true, sha256: hash.digest("hex") };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let text = "",
    expired = false;
  // Error diagnostics must not turn a rejected read into an unbounded body wait.
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => undefined);
  }, 1000);
  try {
    for (;;) {
      const next = await reader.read();
      if (expired) return result;
      if (next.done) {
        result.eof = true;
        result.sha256 = hash.digest("hex");
        break;
      }
      result.bytes += next.value.byteLength;
      if (result.bytes > 65536) return result;
      hash.update(next.value);
      text += decoder.decode(next.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(text + decoder.decode());
    result.parsedJson = true;
    if (parsed && typeof parsed === "object" && "name" in parsed) {
      switch (parsed.name) {
        case "UnknownError":
        case "ServiceUnavailableError":
        case "PermissionNotFoundError":
        case "FormNotFoundError":
          result.errorCode = parsed.name;
      }
    }
    return result;
  } catch {
    return result;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
