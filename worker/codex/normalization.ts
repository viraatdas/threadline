import type { ManualOverride } from "../../lib/domain/schemas";

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

function camelCase(value: string): string {
  return value.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

export function isManuallyOverridden(overrides: readonly ManualOverride[], field: string): boolean {
  const aliases = new Set([field, snakeCase(field), camelCase(field)]);
  return overrides.some((override) => aliases.has(override.field));
}

export function preserveManualOverrides<T extends object>(
  current: T,
  proposed: Partial<T>,
  overrides: readonly ManualOverride[],
): T {
  const merged = { ...current };
  for (const [field, value] of Object.entries(proposed)) {
    if (!isManuallyOverridden(overrides, field)) {
      (merged as Record<string, unknown>)[field] = value;
    }
  }
  return merged as T;
}

export function normalizeCompanyName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}
