import { createHash } from "node:crypto";

export function createIdempotencyKey(namespace: string, ...parts: readonly unknown[]): string {
  const hash = createHash("sha256");
  hash.update(namespace.trim().toLowerCase());

  for (const part of parts) {
    hash.update("\u001f");
    hash.update(stableSerialize(part));
  }

  return `${namespace}:${hash.digest("hex")}`;
}

export function hashContent(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableSerialize(child)}`)
    .join(",")}}`;
}
