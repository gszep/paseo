export class OpenCodeHttpError extends Error {
  readonly name = "OpenCodeHttpError";

  constructor(
    readonly operation: string,
    readonly status: number | undefined,
    readonly html: boolean,
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
  const html = response.headers.get("content-type")?.includes("text/html") ?? false;
  if (!response.ok || html) {
    await response.body?.cancel();
    throw new OpenCodeHttpError(operation, response.status, html);
  }
}
