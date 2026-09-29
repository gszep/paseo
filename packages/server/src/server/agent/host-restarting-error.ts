/**
 * Thrown when a prompt is submitted to a daemon that is draining for a
 * restart. The prompt was NOT admitted to any provider, so the client may
 * safely retry it (the app's saved-operation path treats an
 * `admission: "not_admitted"` rejection as `not_committed`).
 *
 * This is deliberately a distinct class from `MessageNotAdmittedError` so the
 * session can report a clear, retryable "host restarting" reason without
 * conflating it with a receipt conflict.
 */
export class HostRestartingError extends Error {
  readonly code = "host_restarting";

  constructor() {
    super("Host is restarting; retry this prompt after the replacement worker is ready.");
    this.name = "HostRestartingError";
  }
}

export function isHostRestartingError(error: unknown): error is HostRestartingError {
  return error instanceof HostRestartingError;
}
