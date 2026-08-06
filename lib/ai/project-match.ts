import "server-only";

// Light-LLM project matching. Given a project the owner defines (a name and a
// plain-language description of who/what it is about), a cheap fast model
// decides, per contact, whether that person is relevant to the project and why.
//
// This is a READ-ONLY classification: it reads already-ingested relationship
// context (name, title, company, the cheap-model digest, recent subjects and
// snippets) and returns a verdict. It never sends, posts, or mutates anything
// through any provider.
//
// The model is reached directly through OpenRouter so the owner can point it at
// any hosted model (default: z-ai/glm-5.3-flash — a small reasoning model).
// The key lives only in the deployment's secret store (OPENROUTER_API_KEY),
// never in source. Contact content is treated as hostile input and is never
// logged.

const DEFAULT_MODEL = "z-ai/glm-5.3-flash";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
// Small reasoning models spend most of their budget thinking; leave generous
// headroom so the JSON answer is never truncated after the reasoning tokens.
const MAX_TOKENS_PER_BATCH = 2400;
const BATCH_SIZE = 6;
const MAX_CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 45_000;

export interface ProjectMatchContact {
  id: string;
  name: string;
  title?: string | null | undefined;
  company?: string | null | undefined;
  digest?: string | null | undefined;
  context?: string | null | undefined;
}

export interface ProjectMatchVerdict {
  id: string;
  match: boolean;
  confidence: number;
  reason: string;
}

export interface ProjectMatchRequest {
  name: string;
  description: string;
  contacts: ProjectMatchContact[];
}

export class ProjectMatchConfigError extends Error {}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function trimReason(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

// Compact one-contact description. Kept short and quoted so the model can tell
// contacts apart inside a batch without us shipping full message bodies.
function describeContact(contact: ProjectMatchContact): string {
  const parts: string[] = [contact.name || "Unknown"];
  const role = [contact.title, contact.company].filter(Boolean).join(" @ ");
  if (role) parts.push(role);
  if (contact.digest) parts.push(`Digest: ${contact.digest}`);
  if (contact.context) parts.push(`Context: ${contact.context}`);
  return parts.join(" — ").slice(0, 600);
}

function buildMessages(request: ProjectMatchRequest, batch: ProjectMatchContact[]) {
  const roster = batch
    .map((contact, index) => `${index + 1}. [id:${contact.id}] ${describeContact(contact)}`)
    .join("\n");

  const system =
    "You decide whether each contact is relevant to a project the user is " +
    "working on. Relevant means the person is a plausible person to reach out " +
    "to about this project: a potential user, customer, advisor, hire, design " +
    "partner, or domain expert. Judge from their role, company, and recent " +
    "conversation context. Be decisive but honest — a generic newsletter or an " +
    "unrelated vendor is not a match.\n\n" +
    `Project name: ${request.name}\n` +
    `Project description: ${request.description}\n\n` +
    'Reply with ONLY a JSON object of the form {"results":[{"id":string,' +
    '"match":boolean,"confidence":number 0..1,"reason":string}]} with one entry ' +
    "per contact, echoing each contact's id. Keep each reason under 14 words.";

  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: `Contacts:\n${roster}` },
  ];
}

function parseVerdicts(content: string, batch: ProjectMatchContact[]): ProjectMatchVerdict[] {
  const ids = new Set(batch.map((c) => c.id));
  let payload: unknown;
  try {
    payload = JSON.parse(content);
  } catch {
    // Some models wrap JSON in prose or code fences; recover the object body.
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start === -1 || end <= start) return [];
    try {
      payload = JSON.parse(content.slice(start, end + 1));
    } catch {
      return [];
    }
  }
  const rows = Array.isArray((payload as { results?: unknown })?.results)
    ? (payload as { results: unknown[] }).results
    : Array.isArray(payload)
      ? (payload as unknown[])
      : [];
  const out: ProjectMatchVerdict[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!ids.has(id)) continue;
    out.push({
      id,
      match: record.match === true,
      confidence: clampConfidence(record.confidence),
      reason: trimReason(record.reason),
    });
  }
  return out;
}

async function classifyBatch(
  request: ProjectMatchRequest,
  batch: ProjectMatchContact[],
  apiKey: string,
  model: string,
  baseUrl: string,
): Promise<ProjectMatchVerdict[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        // OpenRouter attribution headers (optional but recommended).
        "x-title": "Threadline",
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        max_tokens: MAX_TOKENS_PER_BATCH,
        messages: buildMessages(request, batch),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      // Never log the response body — it can echo prompt content.
      throw new Error(`OpenRouter request failed with status ${response.status}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    return parseVerdicts(content, batch);
  } finally {
    clearTimeout(timer);
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// Run batches with a small concurrency ceiling. A failed batch degrades to "no
// verdict" for those contacts rather than failing the whole run.
async function runWithConcurrency(
  batches: ProjectMatchContact[][],
  worker: (batch: ProjectMatchContact[]) => Promise<ProjectMatchVerdict[]>,
): Promise<ProjectMatchVerdict[]> {
  const results: ProjectMatchVerdict[] = [];
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < batches.length) {
      const index = cursor;
      cursor += 1;
      const batch = batches[index];
      if (!batch) continue;
      try {
        results.push(...(await worker(batch)));
      } catch {
        // Skip this batch; its contacts simply return unranked.
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(MAX_CONCURRENCY, batches.length) },
    () => pump(),
  );
  await Promise.all(workers);
  return results;
}

export function isProjectMatchConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

export async function classifyProjectMatches(
  request: ProjectMatchRequest,
): Promise<ProjectMatchVerdict[]> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new ProjectMatchConfigError(
      "OPENROUTER_API_KEY is not set. Add it to the deployment secret store to enable project matching.",
    );
  }
  if (request.contacts.length === 0) return [];
  const model = process.env.PROJECT_MATCH_MODEL || DEFAULT_MODEL;
  const baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL;

  const batches = chunk(request.contacts, BATCH_SIZE);
  const verdicts = await runWithConcurrency(batches, (batch) =>
    classifyBatch(request, batch, apiKey, model, baseUrl),
  );

  // Preserve the caller's contact order; de-duplicate on id.
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  return request.contacts
    .map((contact) => byId.get(contact.id))
    .filter((v): v is ProjectMatchVerdict => Boolean(v));
}
