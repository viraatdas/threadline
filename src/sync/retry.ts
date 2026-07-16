export class SyncTimeoutError extends Error {
  readonly code = "sync_timeout";

  constructor(readonly timeoutMs: number) {
    super(`Channel synchronization exceeded ${timeoutMs}ms.`);
    this.name = "SyncTimeoutError";
  }
}

export async function runWithRetry<T>(input: {
  operation: (signal: AbortSignal, attempt: number) => Promise<T>;
  maxAttempts: number;
  timeoutMs: number;
  signal?: AbortSignal;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
}): Promise<{ value: T; attempts: number }> {
  const sleep =
    input.sleep ??
    ((milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const random = input.random ?? Math.random;
  const maximumAttempts = Math.max(1, input.maxAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    if (input.signal?.aborted) throw input.signal.reason;
    try {
      const value = await runWithTimeout(
        (signal) => input.operation(signal, attempt),
        input.timeoutMs,
        input.signal,
      );
      return { value, attempts: attempt };
    } catch (error) {
      lastError = error;
      const retryable = input.isRetryable?.(error) ?? defaultRetryable(error);
      if (!retryable || attempt >= maximumAttempts)
        throw withAttempts(error, attempt);
      await sleep(retryDelayMs(attempt, random));
    }
  }

  throw lastError;
}

async function runWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeoutError = new SyncTimeoutError(timeoutMs);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => {
        controller.abort(timeoutError);
        reject(timeoutError);
      },
      Math.max(1, timeoutMs),
    );
  });

  try {
    if (parentSignal?.aborted) throw parentSignal.reason;
    return await Promise.race([operation(controller.signal), timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function retryDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(4_000, 250 * 2 ** (attempt - 1));
  return Math.round(base * (0.75 + random() * 0.5));
}

function defaultRetryable(error: unknown): boolean {
  if (error instanceof SyncTimeoutError) return false;
  if (isAbortError(error)) return false;
  if (typeof error === "object" && error !== null && "retryable" in error) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  return true;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function withAttempts(error: unknown, attempts: number): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    Object.isExtensible(error)
  ) {
    Object.defineProperty(error, "attempts", {
      configurable: true,
      enumerable: false,
      value: attempts,
    });
    return error;
  }
  const wrapped = new Error(
    error instanceof Error ? error.message : "Channel synchronization failed.",
    { cause: error },
  );
  return Object.assign(wrapped, { attempts });
}
