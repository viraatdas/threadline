"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import {
  disconnectAction,
  importLinkedinCookiesAction,
  saveApiKeyAction,
  saveSettingsAction,
  signOutLinkedinAction,
} from "@/app/(app)/actions";
import { Button, Field, Input, Section, Status, Textarea, relativeTime } from "@/components/ui";
import type { Settings } from "@/lib/domain";
import type { SettingsData } from "@/lib/queries";

export function SettingsView({ data, notice }: { data: SettingsData; notice?: { gmail?: string; reason?: string } }) {
  return (
    <div>
      <div className="border-b border-line pb-6">
        <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">Settings</h1>
        <p className="mt-2 text-[14px] text-ink-muted">What you sell, who you are, and the accounts messages go out from.</p>
      </div>
      {notice?.gmail === "connected" ? <p className="mt-4"><Status tone="accent">Gmail connected.</Status></p> : null}
      {notice?.gmail === "error" ? <p className="mt-4"><Status tone="danger">Gmail connection failed: {notice.reason ?? "unknown error"}</Status></p> : null}
      <Connections data={data} />
      <ProductForm settings={data.settings} />
    </div>
  );
}

function ConnectionRow({ name, state, children }: { name: string; state: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-3 py-4 lg:grid-cols-[220px_1fr] lg:gap-8">
      <div>
        <p className="text-[14px] font-medium">{name}</p>
        <div className="mt-1">{state}</div>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Connections({ data }: { data: SettingsData }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [keys, setKeys] = useState({ github: "", apollo: "" });
  const [cookies, setCookies] = useState("");

  const act = (work: () => Promise<{ ok: boolean; error?: string }>, success: string) =>
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return void toast.error(result.error ?? "Failed");
      toast.success(success);
      router.refresh();
    });

  return (
    <Section title="Accounts" description="Credentials are encrypted at rest and never shown again after you save them.">
      <div className="divide-y divide-line border-y border-line">
        <ConnectionRow
          name="Gmail"
          state={
            data.gmail ? (
              <Status tone={data.gmail.lastError ? "warning" : "accent"}>{data.gmail.label}</Status>
            ) : (
              <Status>not connected</Status>
            )
          }
        >
          <p className="text-[13px] leading-5 text-ink-muted">
            Sends approved emails from your Gmail and reads only what’s needed to notice replies and bounces.
            {data.gmail?.lastError ? <span className="mt-1 block text-danger">Last error: {data.gmail.lastError}</span> : null}
          </p>
          <div className="mt-3 flex gap-2">
            <a
              href="/api/integrations/gmail/connect?returnTo=/settings"
              className="inline-flex h-8 items-center rounded-[7px] bg-accent px-2.5 text-[12px] font-medium text-white hover:bg-accent-strong"
            >
              {data.gmail ? "Reconnect" : "Connect Gmail"}
            </a>
            {data.gmail ? (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(() => disconnectAction("gmail"), "Gmail disconnected")}>
                Disconnect
              </Button>
            ) : null}
          </div>
        </ConnectionRow>

        <ConnectionRow name="LinkedIn" state={<LinkedinState linkedin={data.linkedin} />}>
          <p className="text-[13px] leading-5 text-ink-muted">
            Runs on our own{" "}
            <a className="underline" href="https://github.com/browser-use/browser-use" target="_blank" rel="noreferrer">
              browser-use
            </a>{" "}
            worker (Fly app <code className="rounded bg-surface-subtle px-1">threadline-browser</code>): an AI agent drives a
            Chromium signed in with your LinkedIn cookies, only on linkedin.com. Used for people search, connection requests,
            messages (each only after you click Send) and reading your inbox list for replies. LinkedIn may restrict accounts
            that automate, so keep the daily limit low.
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] leading-5 text-ink-muted">
            <li>
              Once: make an always-on computer at home a Tailscale exit node (the worker’s TS_EXIT_NODE). The worker’s
              browser only goes out through it, so LinkedIn sees your home connection; while it’s offline, LinkedIn
              actions wait.
            </li>
            <li>
              Sign in to LinkedIn in your browser, then on linkedin.com open the Cookie-Editor extension → Export → JSON and
              paste it below (or run <code className="rounded bg-surface-subtle px-1">pnpm linkedin-login</code> on your Mac).
              Your cookies go only to the worker, never into this app’s database.
            </li>
          </ol>
          <form
            className="mt-3 space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              act(() => importLinkedinCookiesAction(cookies), "LinkedIn signed in on the worker");
              setCookies("");
            }}
          >
            <Textarea
              rows={3}
              autoComplete="off"
              spellCheck={false}
              value={cookies}
              onChange={(event) => setCookies(event.target.value)}
              placeholder="Paste the LinkedIn cookie export (JSON)"
              aria-label="LinkedIn cookie export"
              className="font-mono text-[12px]"
            />
            <Button type="submit" size="sm" variant="primary" disabled={pending || cookies.trim().length < 20}>
              Import cookies
            </Button>
          </form>
          {data.linkedin.state === "signed_in" || data.linkedin.state === "signed_out" ? (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              disabled={pending || data.linkedin.state === "signed_out"}
              onClick={() => act(() => signOutLinkedinAction(), "LinkedIn signed out on the worker")}
            >
              Sign out on worker
            </Button>
          ) : null}
        </ConnectionRow>

        {(
          [
            {
              key: "github",
              name: "GitHub token",
              help: "Lets Find search GitHub Actions workflows for macOS/Xcode jobs, and Research check a company’s org. A fine-grained token with no extra permissions (public repos) is enough.",
            },
            {
              key: "apollo",
              name: "Apollo API key",
              help: "Optional. Adds people search by company domain and verified email lookup (uses Apollo credits). Without it, people come from YC founder pages and LinkedIn, and emails are pattern guesses.",
            },
          ] as const
        ).map(({ key, name, help }) => (
          <ConnectionRow
            key={key}
            name={name}
            state={
              data.keys[key] ? (
                <Status tone="accent">{data.keys[key] === "env" ? "set via environment" : "saved"}</Status>
              ) : (
                <Status>not set</Status>
              )
            }
          >
            <p id={key === "github" ? "keys" : undefined} className="text-[13px] leading-5 text-ink-muted">
              {help}
            </p>
            <form
              className="mt-3 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                act(() => saveApiKeyAction(key, keys[key]), `${name} saved`);
                setKeys({ ...keys, [key]: "" });
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                value={keys[key]}
                onChange={(event) => setKeys({ ...keys, [key]: event.target.value })}
                placeholder={data.keys[key] ? "Replace…" : "Paste key"}
                aria-label={name}
              />
              <Button type="submit" size="sm" variant="primary" className="h-9" disabled={pending || keys[key].length < 8}>
                Save
              </Button>
              {data.keys[key] === "stored" ? (
                <Button size="sm" variant="ghost" className="h-9" disabled={pending} onClick={() => act(() => disconnectAction(key), `${name} removed`)}>
                  Remove
                </Button>
              ) : null}
            </form>
          </ConnectionRow>
        ))}
      </div>
    </Section>
  );
}

function ProductForm({ settings }: { settings: Settings }) {
  const router = useRouter();
  const [form, setForm] = useState(settings);
  const [pending, startTransition] = useTransition();
  const text = (key: "productName" | "productUrl" | "senderName") => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value }),
  });
  const number = (key: "dailyEmailLimit" | "dailyLinkedinLimit" | "inviteNoteLimit") => ({
    type: "number",
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [key]: Number(event.target.value) }),
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await saveSettingsAction(form);
          if (!result.ok) return void toast.error(result.error);
          toast.success("Settings saved");
          router.refresh();
        });
      }}
    >
      <Section title="Product" description="Research scores prospects against this, and every draft is written from it.">
        <div className="grid max-w-3xl gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name"><Input {...text("productName")} required /></Field>
            <Field label="URL"><Input {...text("productUrl")} type="url" required /></Field>
          </div>
          <Field label="Pitch" hint="What it is, what it costs, why it’s better. Facts the drafts can use.">
            <Textarea rows={6} value={form.pitch} onChange={(event) => setForm({ ...form, pitch: event.target.value })} required />
          </Field>
          <Field label="Ideal customer" hint="Who buys and which titles to contact.">
            <Textarea rows={4} value={form.icp} onChange={(event) => setForm({ ...form, icp: event.target.value })} required />
          </Field>
        </div>
      </Section>
      <Section title="Sending">
        <div className="grid max-w-3xl gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Your name"><Input {...text("senderName")} required /></Field>
          </div>
          <Field label="Email signature" hint="Appended to every email exactly as written. For US commercial email, include a postal address.">
            <Textarea rows={3} value={form.signature} onChange={(event) => setForm({ ...form, signature: event.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Emails per 24h"><Input {...number("dailyEmailLimit")} min={0} max={200} /></Field>
            <Field label="LinkedIn actions per 24h"><Input {...number("dailyLinkedinLimit")} min={0} max={100} /></Field>
            <Field label="Invite note limit" hint="200 free, 300 Premium"><Input {...number("inviteNoteLimit")} min={0} max={300} /></Field>
          </div>
          <div>
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? "Saving…" : "Save settings"}
            </Button>
          </div>
        </div>
      </Section>
    </form>
  );
}

function LinkedinState({ linkedin }: { linkedin: SettingsData["linkedin"] }) {
  switch (linkedin.state) {
    case "unconfigured":
      return <Status>worker not configured</Status>;
    case "unreachable":
      return <Status tone="danger">worker unreachable</Status>;
    case "signed_out":
      return (
        <div className="space-y-1">
          <Status tone="warning">not signed in</Status>
          {linkedin.lastCheck ? <p className="text-[12px] text-ink-muted">{linkedin.lastCheck}</p> : null}
          <HomeState home={linkedin.home} />
        </div>
      );
    case "signed_in":
      return (
        <div className="space-y-1">
          <Status tone="accent">signed in</Status>
          {linkedin.verifiedAt ? <p className="text-[12px] text-ink-muted">checked {relativeTime(linkedin.verifiedAt)}</p> : null}
          <HomeState home={linkedin.home} />
        </div>
      );
  }
}

function HomeState({ home }: { home: { online: boolean; detail: string } | null }) {
  if (!home) return null;
  return (
    <div className="space-y-1">
      <Status tone={home.online ? "accent" : "warning"}>{home.online ? "home connection online" : "home connection offline"}</Status>
      {home.online ? null : <p className="text-[12px] text-ink-muted">{home.detail}</p>}
    </div>
  );
}
