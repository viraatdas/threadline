"use client";

import { AtSign, ExternalLink, UserRound, Mail, RefreshCw, RotateCcw, Send, SkipForward } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { redraftAction, refreshAction, sendAction, skipAction, updatePersonAction } from "@/app/(app)/actions";
import { Button, Empty, Input, Section, Status, Textarea, relativeTime } from "@/components/ui";
import { CHANNEL_LABELS } from "@/lib/domain";
import type { TodayData } from "@/lib/queries";

export function Today({ data }: { data: TodayData }) {
  const [refreshing, startRefresh] = useTransition();
  const drafts = data.queue.filter((row) => row.message.status === "draft");
  const failed = data.queue.filter((row) => row.message.status === "failed");
  const pending = data.queue.filter((row) => row.message.status === "sending");

  const onRefresh = () =>
    startRefresh(async () => {
      const result = await refreshAction();
      if (!result.ok) return void toast.error(result.error);
      const { replies, drafted, problems } = result.data;
      toast.success(`${replies} new ${replies === 1 ? "reply" : "replies"} · ${drafted} drafts written`);
      problems.slice(0, 3).forEach((problem) => toast.warning(problem));
    });

  return (
    <div>
      <div className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">Today</h1>
          <p className="mt-2 text-[14px] text-ink-muted">
            <span className="tabular-nums">{data.stats.active}</span> in sequence ·{" "}
            <span className="tabular-nums">{data.stats.sentWeek}</span> sent this week ·{" "}
            <span className="tabular-nums">{data.stats.repliesWeek}</span> replies this week
            {data.stats.nextDueAt ? <> · next follow-up {relativeTime(data.stats.nextDueAt)}</> : null}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-ink-faint">
            Checked {data.runtime.lastRefreshAt ? relativeTime(data.runtime.lastRefreshAt) : "never"}
          </span>
          <Button onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} aria-hidden="true" />
            {refreshing ? "Checking…" : "Check replies"}
          </Button>
        </div>
      </div>

      {data.replies.length ? (
        <Section title={`Replies (${data.replies.length})`} description="They wrote back. Sequences stop automatically; decide what's next.">
          <ul className="divide-y divide-line border-y border-line">
            {data.replies.map((reply, index) => (
              <ReplyRow key={`${reply.person.id}-${index}`} reply={reply} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section
        title={`Ready to send (${drafts.length + failed.length})`}
        description="Every message waits for you. Edit anything, then send. Follow-ups appear here when they come due, and stop if they reply."
      >
        {drafts.length + failed.length === 0 ? (
          <Empty>
            Nothing due right now. <Link className="font-medium text-accent-strong underline-offset-2 hover:underline" href="/find">Find prospects</Link>, research them, then enroll the best ones in a{" "}
            <Link className="font-medium text-accent-strong underline-offset-2 hover:underline" href="/campaigns">campaign</Link>.
          </Empty>
        ) : (
          <div className="space-y-4">
            {[...failed, ...drafts].map((row) => (
              <DraftCard key={row.message.id} row={row} />
            ))}
          </div>
        )}
      </Section>

      {pending.length ? (
        <Section title={`Queued on LinkedIn (${pending.length})`} description="LinkedIn actions run in our browser worker and take a minute or two (longer while your home connection is offline). They're confirmed on the next check (hourly, or Check replies).">
          <ul className="divide-y divide-line border-y border-line text-[13px]">
            {pending.map((row) => (
              <li key={row.message.id} className="flex items-center justify-between gap-3 py-3">
                <span>
                  {CHANNEL_LABELS[row.message.channel]} to <span className="font-medium">{row.person.name}</span>
                  {row.company ? <span className="text-ink-muted"> · {row.company.name}</span> : null}
                </span>
                <Status tone="warning">queued {relativeTime(row.message.sentAt)}</Status>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

type Row = TodayData["queue"][number];

// X has no DM API we use: Today opens the compose screen with the text
// prefilled (or the profile, when we lack their numeric id) and the owner
// presses send inside X.
function xDestination(person: Row["person"], body: string): string | null {
  const profile = person.twitterUrl && /^https:\/\/(?:x|twitter)\.com\/\w{1,30}$/i.test(person.twitterUrl) ? person.twitterUrl : null;
  const id = typeof person.metadata.xUserId === "string" && /^\d{1,25}$/.test(person.metadata.xUserId) ? person.metadata.xUserId : null;
  if (id) return `https://x.com/messages/compose?recipient_id=${id}&text=${encodeURIComponent(body)}`;
  return profile;
}

function DraftCard({ row }: { row: Row }) {
  const { message, person, company, campaign } = row;
  const [subject, setSubject] = useState(message.subject ?? "");
  const [body, setBody] = useState(message.body);
  const [pending, startTransition] = useTransition();
  const [gone, setGone] = useState(false);
  const isEmail = message.channel === "email";
  const isX = message.channel === "x_dm";
  const firstEmail = isEmail && message.subject !== null;
  const stepCount = campaign?.steps.length ?? 0;
  const limit = message.channel === "linkedin_invite" ? 300 : null;

  if (gone) return null;

  const send = () => {
    if (isX) {
      // Opened synchronously inside the click so the popup isn't blocked.
      const destination = xDestination(person, body.trim());
      if (!destination) return void toast.error("No X profile for this person.");
      window.open(destination, "_blank", "noopener,noreferrer");
      void navigator.clipboard?.writeText(body.trim()).catch(() => undefined);
    }
    startTransition(async () => {
      const result = await sendAction(message.id, { body, ...(firstEmail ? { subject } : {}) });
      if (!result.ok) return void toast.error(result.error);
      const outcome = result.data;
      if (outcome.status === "sent") {
        toast.success(isX ? `Opened X for ${person.name} — press send there (text is also copied)` : `Sent to ${person.name}`);
        setGone(true);
      } else if (outcome.status === "pending") {
        toast.message(outcome.detail);
        setGone(true);
      } else if (outcome.status === "skipped") {
        toast.message(outcome.detail);
        setGone(true);
      } else toast.error(outcome.detail);
    });
  };

  const skip = () =>
    startTransition(async () => {
      const result = await skipAction(message.id);
      if (!result.ok) return void toast.error(result.error);
      setGone(true);
    });

  const rewrite = () =>
    startTransition(async () => {
      const result = await redraftAction(message.id);
      if (!result.ok) return void toast.error(result.error);
      setBody(result.data.body);
      if (result.data.subject) setSubject(result.data.subject);
    });

  return (
    <article className="rounded-[10px] border border-line bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-[14px] font-medium text-ink">
            {person.name}
            {person.title ? <span className="font-normal text-ink-muted"> · {person.title}</span> : null}
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] text-ink-muted">
            {company ? (
              <Link href={`/prospects/${company.id}`} className="font-medium text-ink hover:underline">
                {company.name}
              </Link>
            ) : null}
            {isEmail ? (
              <span className="inline-flex items-center gap-1">
                <Mail className="size-3" aria-hidden="true" />
                {person.email ?? "no email"}
                {person.emailStatus === "guessed" ? <Status tone="warning">guessed address</Status> : null}
                {typeof person.metadata.priorThreads === "number" && person.metadata.priorThreads > 0 ? (
                  <Status tone="blue">{person.metadata.priorThreads} earlier threads with you</Status>
                ) : null}
              </span>
            ) : isX && person.twitterUrl ? (
              <a href={person.twitterUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                <AtSign className="size-3" aria-hidden="true" />
                {person.twitterUrl.replace(/^https:\/\/(?:x|twitter)\.com\//i, "")}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : person.linkedinUrl ? (
              <a href={person.linkedinUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                <UserRound className="size-3" aria-hidden="true" />
                profile
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ) : null}
          </p>
        </div>
        <div className="text-right text-[12px] text-ink-muted">
          <p className="font-medium text-ink">{CHANNEL_LABELS[message.channel]}</p>
          <p>
            {campaign ? `${campaign.name} · step ${(message.step ?? 0) + 1}/${stepCount}` : "one-off"}
          </p>
        </div>
      </header>
      <div className="space-y-3 px-4 py-3">
        {message.status === "failed" && message.error ? (
          <Status tone="danger">Last attempt failed: {message.error}</Status>
        ) : null}
        {firstEmail ? (
          <Input aria-label="Subject" value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" />
        ) : null}
        <Textarea
          aria-label="Message"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={Math.min(14, Math.max(4, body.split("\n").length + 1))}
        />
        {limit ? (
          <p className={body.length > limit ? "text-[12px] text-danger" : "text-[12px] text-ink-faint"}>
            {body.length} characters (LinkedIn notes: 200 free, 300 Premium)
          </p>
        ) : null}
        {isEmail ? <p className="text-[12px] text-ink-faint">Your signature is added when it sends.</p> : null}
        {isX ? <p className="text-[12px] text-ink-faint">Opens X with this message filled in. You press send there; this step is then marked sent.</p> : null}
      </div>
      <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
        <Button variant="ghost" size="sm" onClick={skip} disabled={pending}>
          <SkipForward className="size-3.5" aria-hidden="true" />
          Skip step
        </Button>
        <Button variant="ghost" size="sm" onClick={rewrite} disabled={pending}>
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Rewrite
        </Button>
        <Button variant="primary" size="sm" onClick={send} disabled={pending || !body.trim()}>
          <Send className="size-3.5" aria-hidden="true" />
          {pending ? "Working…" : isX ? "Open in X" : message.status === "failed" ? "Retry send" : "Send"}
        </Button>
      </footer>
    </article>
  );
}

function ReplyRow({ reply }: { reply: TodayData["replies"][number] }) {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState<string | null>(null);
  const set = (stage: "meeting" | "closed" | "active", label: string) =>
    startTransition(async () => {
      const result = await updatePersonAction(reply.person.id, { stage });
      if (!result.ok) return void toast.error(result.error);
      setDone(label);
    });
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="text-[14px] font-medium">
          {reply.person.name}
          {reply.company ? (
            <Link href={`/prospects/${reply.company.id}`} className="font-normal text-ink-muted hover:underline">
              {" "}
              · {reply.company.name}
            </Link>
          ) : null}
          <span className="ml-2 text-[12px] font-normal text-ink-faint">{relativeTime(reply.message.sentAt)}</span>
        </p>
        <p className="mt-1 line-clamp-3 max-w-3xl text-[13px] leading-6 text-ink-muted">{reply.message.body || "(no preview)"}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {done ? (
          <Status tone="accent">{done}</Status>
        ) : (
          <>
            <Button size="sm" variant="primary" disabled={pending} onClick={() => set("meeting", "Meeting")}>
              Meeting booked
            </Button>
            <Button size="sm" disabled={pending} onClick={() => set("closed", "Closed")}>
              Not interested
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => set("active", "Resumed")}>
              Resume sequence
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
