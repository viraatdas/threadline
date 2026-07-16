import type { JsonObject, WorkerLogger } from "./types";

function write(level: "info" | "warn" | "error", event: string, fields: JsonObject = {}): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export const structuredLogger: WorkerLogger = {
  info: (event, fields) => write("info", event, fields),
  warn: (event, fields) => write("warn", event, fields),
  error: (event, fields) => write("error", event, fields),
};
