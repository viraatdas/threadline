"use client";

import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  ContactRound,
  Mail,
  MessageCircle,
  RefreshCw,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { PageHeader } from "@/components/shell";

type IntegrationKey = "gmail" | "linkedin" | "x";
type ConnectionState =
  | "checking"
  | "connected"
  | "attention"
  | "not_connected";

interface IntegrationStatus {
  state: ConnectionState;
  detail: string;
  lastSyncedAt?: string | null;
}

interface IntegrationDefinition {
  key: IntegrationKey;
  name: string;
  description: string;
  setup: string;
  icon: LucideIcon;
}

const integrations: IntegrationDefinition[] = [
  {
    key: "gmail",
    name: "Gmail",
    description: "Email threads, participants, replies, and delivery metadata.",
    setup: "Authorize the read-only Gmail scope through Google OAuth.",
    icon: Mail,
  },
  {
    key: "linkedin",
    name: "LinkedIn",
    description:
      "Inbox conversations and identity context through Linked API.",
    setup: "Provision Linked API credentials through the secure operator flow.",
    icon: ContactRound,
  },
  {
    key: "x",
    name: "X",
    description:
      "Direct-message history through the isolated read-only connector.",
    setup:
      "Install the owner cookie through the local encrypted credential tool.",
    icon: MessageCircle,
  },
];

const initialStatuses: Record<IntegrationKey, IntegrationStatus> = {
  gmail: { state: "checking", detail: "Checking connection…" },
  linkedin: { state: "checking", detail: "Checking connection…" },
  x: { state: "checking", detail: "Checking connection…" },
};

const secondaryButtonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-[7px] border border-line bg-white px-3 text-[12px] font-semibold text-ink transition-colors hover:border-line-strong hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

function statusLabel(state: ConnectionState) {
  if (state === "connected") return "Connected";
  if (state === "attention") return "Needs attention";
  if (state === "not_connected") return "Not connected";
  return "Checking";
}

function StatusIcon({ state }: { state: ConnectionState }) {
  if (state === "connected") {
    return (
      <CheckCircle2
        className="size-4 text-accent-strong"
        aria-hidden="true"
      />
    );
  }
  if (state === "attention") {
    return (
      <AlertTriangle className="size-4 text-warning" aria-hidden="true" />
    );
  }
  return <CircleDashed className="size-4 text-ink-faint" aria-hidden="true" />;
}

function formatLastSync(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

async function readPayload(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function loadIntegrationStatus(
  key: IntegrationKey,
  signal: AbortSignal,
): Promise<IntegrationStatus> {
  const endpoint =
    key === "gmail"
      ? "/api/integrations/gmail/status"
      : key === "linkedin"
        ? "/api/integrations/linkedin/status"
        : "/api/integrations/x/health";
  const response = await fetch(endpoint, { signal, cache: "no-store" });
  const payload = await readPayload(response);

  if (key === "x") {
    if (response.ok && payload.ok === true) {
      return {
        state: "connected",
        detail: "Read-only DM access is healthy.",
      };
    }
    if (response.status === 404) {
      return {
        state: "not_connected",
        detail: "No encrypted X account is installed.",
      };
    }
    return {
      state: "attention",
      detail: "The X connection needs owner review.",
    };
  }

  const connected = payload.connected === true;
  const providerStatus =
    typeof payload.status === "string" ? payload.status : "";
  const lastSyncedAt =
    typeof payload.lastSyncedAt === "string" ? payload.lastSyncedAt : null;
  if (response.ok && connected) {
    const identity =
      typeof payload.accountEmail === "string"
        ? payload.accountEmail
        : typeof payload.displayName === "string"
          ? payload.displayName
          : null;
    return {
      state: "connected",
      detail: identity
        ? `Connected as ${identity}.`
        : "Read-only access is healthy.",
      lastSyncedAt,
    };
  }
  if (providerStatus === "attention_required" || response.status >= 500) {
    return {
      state: "attention",
      detail: `${key === "gmail" ? "Gmail" : "LinkedIn"} needs owner review.`,
      lastSyncedAt,
    };
  }
  return {
    state: "not_connected",
    detail: `${key === "gmail" ? "Gmail" : "LinkedIn"} is not connected yet.`,
    lastSyncedAt,
  };
}

export function SettingsWorkspace() {
  const [statuses, setStatuses] = useState(initialStatuses);
  const [activeAction, setActiveAction] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadStatuses = useCallback(async (signal?: AbortSignal) => {
    const controller = new AbortController();
    const activeSignal = signal ?? controller.signal;
    const results = await Promise.all(
      integrations.map(async ({ key }) => {
        try {
          return [
            key,
            await loadIntegrationStatus(key, activeSignal),
          ] as const;
        } catch {
          return [
            key,
            {
              state: "attention",
              detail: "Connection status could not be loaded.",
            },
          ] as const;
        }
      }),
    );
    return Object.fromEntries(results) as Record<
      IntegrationKey,
      IntegrationStatus
    >;
  }, []);

  const refreshStatuses = useCallback(async () => {
    setStatuses(await loadStatuses());
  }, [loadStatuses]);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatuses(controller.signal).then((nextStatuses) => {
      if (!controller.signal.aborted) setStatuses(nextStatuses);
    });
    return () => controller.abort();
  }, [loadStatuses]);

  async function runSync(key?: IntegrationKey) {
    const action = key ?? "all";
    const endpoint = key ? `/api/integrations/${key}/sync` : "/api/sync";
    setActiveAction(action);
    setNotice(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error("sync_failed");
      const sourceName = integrations.find((item) => item.key === key)?.name;
      setNotice(
        key ? `${sourceName} sync completed.` : "Sync request completed.",
      );
      await refreshStatuses();
    } catch {
      setNotice(
        "Sync could not be completed. Review the connection status and try again.",
      );
    } finally {
      setActiveAction(null);
    }
  }

  return (
    <div className="space-y-9">
      <PageHeader
        eyebrow="Owner settings"
        title="Sources and sync"
        description="Connect read-only history, review connection health, and start an ingestion pass. Threadline never sends or changes messages in a source account."
        action={
          <button
            type="button"
            onClick={() => void runSync()}
            disabled={activeAction !== null}
            className="inline-flex min-h-9 items-center justify-center gap-2 rounded-[7px] bg-accent px-3.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw
              className={`size-3.5 ${activeAction === "all" ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            Sync all sources
          </button>
        }
      />

      <section aria-labelledby="connection-heading">
        <div className="mb-4">
          <h2
            id="connection-heading"
            className="text-[15px] font-semibold text-ink"
          >
            Connection health
          </h2>
          <p className="mt-1 text-[13px] leading-5 text-ink-muted">
            Credentials stay server-side and encrypted. This screen exposes
            status only.
          </p>
        </div>
        <div className="border-y border-line">
          {integrations.map(
            ({ key, name, description, setup, icon: Icon }) => {
              const status = statuses[key];
              const syncedAt = formatLastSync(status.lastSyncedAt);
              return (
                <article
                  key={key}
                  className="grid gap-4 border-b border-line py-5 last:border-b-0 lg:grid-cols-[minmax(0,1fr)_minmax(230px,0.55fr)_auto] lg:items-center"
                >
                  <div className="flex min-w-0 items-start gap-3.5">
                    <span className="grid size-9 shrink-0 place-items-center rounded-[8px] bg-surface-subtle text-ink-muted">
                      <Icon
                        className="size-4"
                        strokeWidth={1.8}
                        aria-hidden="true"
                      />
                    </span>
                    <div>
                      <h3 className="text-[13px] font-semibold text-ink">
                        {name}
                      </h3>
                      <p className="mt-1 text-[12px] leading-5 text-ink-muted">
                        {description}
                      </p>
                      <p className="mt-1 text-[11px] leading-5 text-ink-faint">
                        {setup}
                      </p>
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-2 text-[12px] font-semibold text-ink">
                      <StatusIcon state={status.state} />
                      {statusLabel(status.state)}
                    </div>
                    <p className="mt-1 text-[11px] leading-5 text-ink-muted">
                      {status.detail}
                    </p>
                    {syncedAt ? (
                      <p className="mt-1 text-[10px] text-ink-faint">
                        Last synced {syncedAt}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2 lg:justify-end">
                    {key === "gmail" && status.state !== "connected" ? (
                      <Link
                        href="/api/integrations/gmail/connect"
                        className={secondaryButtonClass}
                      >
                        Connect Gmail
                      </Link>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void runSync(key)}
                      disabled={
                        status.state !== "connected" || activeAction !== null
                      }
                      className={secondaryButtonClass}
                    >
                      <RefreshCw
                        className={`size-3.5 ${activeAction === key ? "animate-spin" : ""}`}
                        aria-hidden="true"
                      />
                      Sync {name}
                    </button>
                  </div>
                </article>
              );
            },
          )}
        </div>
      </section>

      <section
        aria-labelledby="boundary-heading"
        className="grid gap-6 border-y border-line py-6 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]"
      >
        <div>
          <div className="flex items-center gap-2">
            <ShieldCheck
              className="size-4 text-accent-strong"
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <h2
              id="boundary-heading"
              className="text-[15px] font-semibold text-ink"
            >
              Read-only boundary
            </h2>
          </div>
          <p className="mt-2 max-w-lg text-[13px] leading-6 text-ink-muted">
            Threadline observes history, computes relationship state, and
            produces copy-only suggestions. The owner remains the only person
            who can communicate externally.
          </p>
        </div>
        <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
          {[
            [
              "Allowed",
              "Read messages, normalize evidence, classify outreach, and draft suggestions.",
            ],
            [
              "Prohibited",
              "Send, reply, post, connect, modify, or delete in Gmail, LinkedIn, or X.",
            ],
            [
              "Owner control",
              "Corrections and follow-up plans remain internal, reversible, and auditable.",
            ],
            [
              "Credential handling",
              "OAuth tokens and connector credentials never render in the browser.",
            ],
          ].map(([term, detail]) => (
            <div key={term}>
              <dt className="text-[11px] font-semibold tracking-[0.06em] text-ink-faint uppercase">
                {term}
              </dt>
              <dd className="mt-1 text-[12px] leading-5 text-ink-muted">
                {detail}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className="rounded-[8px] border border-line bg-surface-subtle px-3 py-2.5 text-[12px] text-ink-muted"
        >
          {notice}
        </p>
      ) : null}
    </div>
  );
}
