export type WorkerErrorCode =
  | "authentication_unavailable"
  | "codex_exit_failure"
  | "codex_timeout"
  | "input_too_large"
  | "invalid_model_output"
  | "job_not_running"
  | "job_unsupported"
  | "shutdown"
  | "transaction_conflict"
  | "worker_internal";

export class WorkerError extends Error {
  readonly code: WorkerErrorCode;
  readonly retryable: boolean;

  constructor(code: WorkerErrorCode, message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WorkerError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
  }
}

export function toWorkerError(error: unknown): WorkerError {
  if (error instanceof WorkerError) return error;

  if (error instanceof Error && error.name === "AbortError") {
    return new WorkerError("shutdown", "The worker is shutting down.", {
      cause: error,
      retryable: true,
    });
  }

  return new WorkerError("worker_internal", "The worker encountered an internal failure.", {
    cause: error,
    retryable: true,
  });
}
