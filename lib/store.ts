import "server-only";

import { eq } from "drizzle-orm";

import { getDatabase } from "@/lib/db/client";
import { connections, settings as settingsTable } from "@/lib/db/schema";
import { DEFAULT_SETTINGS, settingsSchema, type Settings } from "@/lib/domain";
import { openCredential, sealCredential } from "@/lib/security/credentials";
import { getEncryptionEnvironment } from "@/lib/security/env";

export type Provider = "gmail" | "linkedin" | "github" | "apollo";

// The AAD binds a ciphertext to its provider, so a sealed LinkedIn token can
// never be replayed as a Gmail credential.
const context = (provider: Provider) => `connection:${provider}`;

export async function loadSettings(): Promise<Settings> {
  const [row] = await getDatabase()
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, "owner"))
    .limit(1);
  const parsed = settingsSchema.partial().safeParse(row?.value ?? {});
  return { ...DEFAULT_SETTINGS, ...(parsed.success ? (stripUndefined(parsed.data) as Partial<Settings>) : {}) };
}

export async function saveSettings(value: Settings): Promise<void> {
  const parsed = settingsSchema.parse(value);
  await getDatabase()
    .insert(settingsTable)
    .values({ id: "owner", value: parsed })
    .onConflictDoUpdate({
      target: settingsTable.id,
      set: { value: parsed, updatedAt: new Date() },
    });
}

export async function loadConnection<T>(
  provider: Provider,
): Promise<{ label: string; credentials: T; metadata: Record<string, unknown> } | null> {
  const [row] = await getDatabase()
    .select()
    .from(connections)
    .where(eq(connections.provider, provider))
    .limit(1);
  if (!row) return null;
  return {
    label: row.label,
    credentials: openCredential<T>(row.credentialCiphertext, context(provider), {
      expectedKeyVersion: row.credentialKeyVersion,
    }),
    metadata: row.metadata,
  };
}

export async function saveConnection(
  provider: Provider,
  label: string,
  credentials: unknown,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const ciphertext = sealCredential(credentials, context(provider));
  const keyVersion = getEncryptionEnvironment().INTEGRATION_ENCRYPTION_KEY_VERSION;
  await getDatabase()
    .insert(connections)
    .values({
      provider,
      label,
      credentialCiphertext: ciphertext,
      credentialKeyVersion: keyVersion,
      metadata,
    })
    .onConflictDoUpdate({
      target: connections.provider,
      set: {
        label,
        credentialCiphertext: ciphertext,
        credentialKeyVersion: keyVersion,
        lastError: null,
        metadata,
        updatedAt: new Date(),
      },
    });
}

export async function updateConnectionCredentials(provider: Provider, credentials: unknown) {
  await getDatabase()
    .update(connections)
    .set({
      credentialCiphertext: sealCredential(credentials, context(provider)),
      credentialKeyVersion: getEncryptionEnvironment().INTEGRATION_ENCRYPTION_KEY_VERSION,
      updatedAt: new Date(),
    })
    .where(eq(connections.provider, provider));
}

export async function recordConnectionError(provider: Provider, message: string | null) {
  await getDatabase()
    .update(connections)
    .set({ lastError: message?.slice(0, 300) ?? null, updatedAt: new Date() })
    .where(eq(connections.provider, provider));
}

export async function deleteConnection(provider: Provider) {
  await getDatabase().delete(connections).where(eq(connections.provider, provider));
}

export async function listConnections() {
  const rows = await getDatabase()
    .select({
      provider: connections.provider,
      label: connections.label,
      lastError: connections.lastError,
      updatedAt: connections.updatedAt,
    })
    .from(connections);
  return Object.fromEntries(rows.map((row) => [row.provider, row])) as Partial<
    Record<Provider, (typeof rows)[number]>
  >;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

// GitHub and Apollo keys can be pasted in Settings (sealed like the others)
// or provided as deployment env vars; the stored one wins.
export async function loadApiKey(provider: "github" | "apollo"): Promise<string | null> {
  const stored = await loadConnection<{ token?: unknown }>(provider).catch(() => null);
  if (stored && typeof stored.credentials.token === "string") return stored.credentials.token;
  return (provider === "github" ? process.env.GITHUB_TOKEN : process.env.APOLLO_API_KEY) || null;
}

interface RuntimeState {
  lastRefreshAt?: string;
  linkedinInboxCheckedAt?: string;
}

export async function loadRuntimeState(): Promise<RuntimeState> {
  const [row] = await getDatabase()
    .select()
    .from(settingsTable)
    .where(eq(settingsTable.id, "runtime"))
    .limit(1);
  return (row?.value ?? {}) as RuntimeState;
}

export async function saveRuntimeState(patch: RuntimeState): Promise<void> {
  const next = { ...(await loadRuntimeState()), ...patch };
  await getDatabase()
    .insert(settingsTable)
    .values({ id: "runtime", value: { ...next } })
    .onConflictDoUpdate({ target: settingsTable.id, set: { value: { ...next }, updatedAt: new Date() } });
}
