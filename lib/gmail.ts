import "server-only";

import { randomBytes } from "node:crypto";

import { z } from "zod";

import { openCredential, sealCredential } from "@/lib/security/credentials";
import { loadConnection, saveConnection, updateConnectionCredentials } from "@/lib/store";

// gmail.send to send, gmail.readonly to see replies/bounces and read the
// Message-ID we need for In-Reply-To on follow-ups. Nothing is ever modified.
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const STATE_CONTEXT = "oauth:gmail:state";
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
export const GMAIL_STATE_COOKIE = "gmail_oauth_nonce";

const credentialsSchema = z.object({
  email: z.string().email(),
  refreshToken: z.string().min(1),
  accessToken: z.string().optional(),
  expiresAt: z.number().optional(),
});
type GmailCredentials = z.infer<typeof credentialsSchema>;

const stateSchema = z.object({
  nonce: z.string().min(16),
  returnTo: z.string().startsWith("/"),
  createdAt: z.number(),
});

function oauthEnvironment() {
  return z
    .object({
      AUTH_GOOGLE_ID: z.string().min(1),
      AUTH_GOOGLE_SECRET: z.string().min(1),
      GMAIL_OAUTH_REDIRECT_URI: z.string().url().optional(),
    })
    .parse(process.env);
}

export function gmailRedirectUri(requestUrl: string) {
  return (
    oauthEnvironment().GMAIL_OAUTH_REDIRECT_URI ??
    new URL("/api/integrations/gmail/callback", requestUrl).toString()
  );
}

export function createAuthorization(input: { redirectUri: string; returnTo: string; loginHint?: string }) {
  const nonce = randomBytes(24).toString("base64url");
  const returnTo =
    input.returnTo.startsWith("/") && !input.returnTo.startsWith("//") ? input.returnTo : "/settings";
  const state = sealCredential({ nonce, returnTo, createdAt: Date.now() }, STATE_CONTEXT);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: oauthEnvironment().AUTH_GOOGLE_ID,
    redirect_uri: input.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent select_account",
    scope: SCOPES.join(" "),
    state,
    ...(input.loginHint ? { login_hint: input.loginHint } : {}),
  }).toString();
  return { url: url.toString(), nonce };
}

export function validateState(state: string, cookieNonce: string | undefined) {
  const parsed = stateSchema.parse(openCredential(state, STATE_CONTEXT));
  if (!cookieNonce || cookieNonce !== parsed.nonce) throw new Error("Gmail OAuth state mismatch.");
  if (Date.now() - parsed.createdAt > STATE_MAX_AGE_MS) throw new Error("Gmail OAuth state expired.");
  return parsed;
}

export async function completeAuthorization(code: string, redirectUri: string) {
  const environment = oauthEnvironment();
  const tokens = await tokenRequest({
    code,
    client_id: environment.AUTH_GOOGLE_ID,
    client_secret: environment.AUTH_GOOGLE_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token.");
  const profile = await fetchJson<{ emailAddress: string }>(`${API}/profile`, tokens.access_token);
  const credentials: GmailCredentials = {
    email: profile.emailAddress.toLowerCase(),
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
  await saveConnection("gmail", credentials.email, credentials, { scopes: SCOPES });
  return credentials.email;
}

async function tokenRequest(body: Record<string, string>) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new GmailError(`Google token exchange failed (HTTP ${response.status}).`, response.status);
  return z
    .object({
      access_token: z.string(),
      expires_in: z.number(),
      refresh_token: z.string().optional(),
    })
    .parse(await response.json());
}

export class GmailError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

export class GmailClient {
  private constructor(private credentials: GmailCredentials) {}

  static async load(): Promise<GmailClient | null> {
    const connection = await loadConnection<unknown>("gmail");
    if (!connection) return null;
    const parsed = credentialsSchema.safeParse(connection.credentials);
    return parsed.success ? new GmailClient(parsed.data) : null;
  }

  get email() {
    return this.credentials.email;
  }

  private async token(): Promise<string> {
    if (this.credentials.accessToken && (this.credentials.expiresAt ?? 0) > Date.now() + 60_000) {
      return this.credentials.accessToken;
    }
    const environment = oauthEnvironment();
    const tokens = await tokenRequest({
      client_id: environment.AUTH_GOOGLE_ID,
      client_secret: environment.AUTH_GOOGLE_SECRET,
      refresh_token: this.credentials.refreshToken,
      grant_type: "refresh_token",
    });
    this.credentials = {
      ...this.credentials,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    };
    await updateConnectionCredentials("gmail", this.credentials);
    return tokens.access_token;
  }

  async send(input: {
    fromName: string;
    to: string;
    toName?: string | undefined;
    subject: string;
    body: string;
    threadId?: string | undefined;
    inReplyTo?: string | undefined;
  }): Promise<{ id: string; threadId: string; rfcMessageId?: string | undefined }> {
    const raw = buildMime({ ...input, from: this.credentials.email });
    const sent = await fetchJson<{ id: string; threadId: string }>(
      `${API}/messages/send`,
      await this.token(),
      { raw, ...(input.threadId ? { threadId: input.threadId } : {}) },
    );
    // The RFC Message-ID is assigned by Gmail; follow-ups need it to thread
    // correctly in the recipient's client, not just in ours.
    const rfcMessageId = await this.messageHeader(sent.id, "Message-ID").catch(() => undefined);
    return { ...sent, ...(rfcMessageId ? { rfcMessageId } : {}) };
  }

  private async messageHeader(id: string, header: string): Promise<string | undefined> {
    const message = await fetchJson<{ payload?: { headers?: { name: string; value: string }[] } }>(
      `${API}/messages/${id}?format=metadata&metadataHeaders=${encodeURIComponent(header)}`,
      await this.token(),
    );
    return message.payload?.headers?.find((h) => h.name.toLowerCase() === header.toLowerCase())?.value;
  }

  // Anything from someone other than us in a thread we started, or any mail
  // from their address since we first wrote, counts as a reply.
  async findReply(input: {
    email?: string | null | undefined;
    threadIds: string[];
    since: Date;
  }): Promise<{ at: Date; snippet: string; from: string; bounced: boolean } | null> {
    const token = await this.token();
    const own = this.credentials.email.toLowerCase();
    for (const threadId of input.threadIds) {
      const thread = await fetchJson<{ messages?: GmailMessageMeta[] }>(
        `${API}/threads/${threadId}?format=metadata&metadataHeaders=From`,
        token,
      ).catch((error: unknown) => {
        if (error instanceof GmailError && error.status === 404) return { messages: [] };
        throw error;
      });
      for (const message of thread.messages ?? []) {
        const from = header(message, "From") ?? "";
        if (from.toLowerCase().includes(own)) continue;
        if (Number(message.internalDate) < input.since.getTime()) continue;
        return {
          at: new Date(Number(message.internalDate)),
          snippet: message.snippet ?? "",
          from,
          bounced: isBounceSender(from),
        };
      }
    }
    if (!input.email) return null;
    const after = Math.floor(input.since.getTime() / 1000);
    const queries = [
      `from:${input.email} after:${after}`,
      `from:(mailer-daemon OR postmaster) "${input.email}" after:${after}`,
    ];
    for (const q of queries) {
      const list = await fetchJson<{ messages?: { id: string }[] }>(
        `${API}/messages?maxResults=1&q=${encodeURIComponent(q)}`,
        token,
      );
      const first = list.messages?.[0];
      if (!first) continue;
      const message = await fetchJson<GmailMessageMeta>(
        `${API}/messages/${first.id}?format=metadata&metadataHeaders=From`,
        token,
      );
      const from = header(message, "From") ?? "";
      return {
        at: new Date(Number(message.internalDate)),
        snippet: message.snippet ?? "",
        from,
        bounced: isBounceSender(from),
      };
    }
    return null;
  }

  // Threads with this address that Threadline didn't start (`exclude`: our own
  // thread ids), optionally only ones active since a date: evidence the owner
  // is already in touch outside the sequence.
  async otherThreadsWith(email: string, exclude: string[], since?: Date): Promise<{ threads: number; lastAt: Date | null }> {
    const token = await this.token();
    const after = since ? ` after:${Math.floor(since.getTime() / 1000)}` : "";
    const q = `(from:${email} OR to:${email} OR cc:${email}) -in:drafts${after}`;
    const list = await fetchJson<{ threads?: { id: string }[] }>(`${API}/threads?maxResults=20&q=${encodeURIComponent(q)}`, token);
    const others = (list.threads ?? []).filter((thread) => !exclude.includes(thread.id));
    const newest = others[0];
    if (!newest) return { threads: 0, lastAt: null };
    // Threads come newest first, so the first one holds the latest message.
    const thread = await fetchJson<{ messages?: { internalDate: string }[] }>(`${API}/threads/${newest.id}?format=minimal`, token);
    const times = (thread.messages ?? []).map((message) => Number(message.internalDate)).filter(Number.isFinite);
    return { threads: others.length, lastAt: times.length ? new Date(Math.max(...times)) : null };
  }
}

interface GmailMessageMeta {
  id: string;
  internalDate: string;
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

function header(message: GmailMessageMeta, name: string) {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function isBounceSender(from: string) {
  return /mailer-daemon|postmaster/i.test(from);
}

async function fetchJson<T>(url: string, token: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new GmailError(`Gmail API request failed (HTTP ${response.status}).`, response.status);
  }
  return (await response.json()) as T;
}

// Header values come from owner-edited drafts and scraped names; a stray CR/LF
// would let them inject headers, so every header is flattened.
const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();

function encodeWord(value: string) {
  const flat = clean(value);
  return /^[\x20-\x7e]*$/.test(flat) ? flat : `=?UTF-8?B?${Buffer.from(flat).toString("base64")}?=`;
}

function address(name: string | undefined, email: string) {
  const safeEmail = clean(email).replace(/[<>",]/g, "");
  if (!name) return safeEmail;
  const encoded = encodeWord(name.replace(/"/g, ""));
  return encoded.startsWith("=?") ? `${encoded} <${safeEmail}>` : `"${encoded}" <${safeEmail}>`;
}

export function buildMime(input: {
  from: string;
  fromName: string;
  to: string;
  toName?: string | undefined;
  subject: string;
  body: string;
  inReplyTo?: string | undefined;
}): string {
  const headers = [
    `From: ${address(input.fromName, input.from)}`,
    `To: ${address(input.toName, input.to)}`,
    `Subject: ${encodeWord(input.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    ...(input.inReplyTo
      ? [`In-Reply-To: ${clean(input.inReplyTo)}`, `References: ${clean(input.inReplyTo)}`]
      : []),
  ];
  const body = Buffer.from(input.body.replace(/\r?\n/g, "\r\n"))
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`).toString("base64url");
}
