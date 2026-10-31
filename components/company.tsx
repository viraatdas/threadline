"use client";

import { AtSign, ExternalLink, UserRound, Mail, Plus, Search, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import {
  addPersonAction,
  deletePersonAction,
  enrollAction,
  findPeopleAction,
  researchAction,
  revealEmailAction,
  setCompanyStatusAction,
  updatePersonAction,
} from "@/app/(app)/actions";
import { Button, Empty, Field, Input, Score, Section, Select, Status, relativeTime } from "@/components/ui";
import type { Message, Person } from "@/lib/db/schema";
import { CHANNEL_LABELS } from "@/lib/domain";
import type { CompanyData } from "@/lib/queries";

const STAGE_TONE = { new: "neutral", active: "blue", replied: "accent", meeting: "accent", closed: "neutral" } as const;

export function CompanyView({
  data,
  campaigns,
  apollo,
}: {
  data: CompanyData;
  campaigns: { id: string; name: string }[];
  apollo: boolean;
}) {
  const { company } = data;
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const metadata = company.metadata as { targetTitles?: string[] };

  const act = <T,>(work: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, onDone?: (data: T) => void) =>
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return void toast.error(result.error);
      onDone?.(result.data);
      router.refresh();
    });

  const links = [
    company.website ? { label: company.domain ?? "website", href: company.website } : null,
    company.linkedinUrl ? { label: "LinkedIn", href: company.linkedinUrl } : null,
    company.githubLogin ? { label: `github/${company.githubLogin}`, href: `https://github.com/${company.githubLogin}` } : null,
    company.ycSlug ? { label: `YC ${company.ycBatch ?? ""}`.trim(), href: `https://www.ycombinator.com/companies/${company.ycSlug}` } : null,
  ].filter((link): link is { label: string; href: string } => link !== null);

  return (
    <div>
      <div className="flex flex-col gap-5 border-b border-line pb-6 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 max-w-3xl">
          <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">{company.name}</h1>
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-ink-muted">
            {links.map((link) => (
              <a key={link.href} href={link.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                {link.label}
                <ExternalLink className="size-3" aria-hidden="true" />
              </a>
            ))}
            {company.location ? <span>{company.location}</span> : null}
            {company.teamSize ? <span>{company.teamSize} people</span> : null}
          </p>
          {company.description ? <p className="mt-3 text-[14px] leading-6 text-ink-muted">{company.description}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button disabled={pending} onClick={() => act(() => researchAction([company.id]), () => toast.success("Researched"))}>
            <Sparkles className="size-3.5" aria-hidden="true" />
            {company.researchedAt ? "Re-research" : "Research"}
          </Button>
          <Button
            variant="primary"
            disabled={pending}
            onClick={() =>
              act(
                () => findPeopleAction(company.id),
                (result) => {
                  toast.success(`Found ${result.found}, added ${result.added}`);
                  result.notes.forEach((note) => toast.message(note));
                },
              )
            }
          >
            <Search className="size-3.5" aria-hidden="true" />
            {pending ? "Working…" : "Find people"}
          </Button>
          <Button
            variant="ghost"
            disabled={pending}
            onClick={() => act(() => setCompanyStatusAction([company.id], company.status === "archived" ? "new" : "archived"))}
          >
            {company.status === "archived" ? "Restore" : "Archive"}
          </Button>
        </div>
      </div>

      <Section title="Fit" description={company.researchedAt ? `Researched ${relativeTime(company.researchedAt)}` : "Not researched yet — Research reads their site and signals and scores them against your pitch."}>
        {company.researchedAt ? (
          <div className="grid gap-4 sm:grid-cols-[80px_1fr]">
            <div className="text-[28px] leading-none">
              <Score value={company.score} />
            </div>
            <div className="space-y-2 text-[14px] leading-6">
              <p>{company.fitSummary}</p>
              {company.hook ? (
                <p className="text-ink-muted">
                  <span className="font-medium text-ink">Hook:</span> {company.hook}
                </p>
              ) : null}
              {metadata.targetTitles?.length ? (
                <p className="text-[13px] text-ink-muted">
                  <span className="font-medium text-ink">Contact:</span> {metadata.targetTitles.join(", ")}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </Section>

      <Section title={`Signals (${data.signals.length})`}>
        {data.signals.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {data.signals.map((signal) => (
              <li key={signal.id} className="flex items-start justify-between gap-4 py-2.5 text-[13px]">
                <div className="min-w-0">
                  <p>
                    {signal.url ? (
                      <a href={signal.url} target="_blank" rel="noreferrer" className="hover:underline">
                        {signal.title}
                      </a>
                    ) : (
                      signal.title
                    )}
                  </p>
                  {signal.detail ? <p className="text-[12px] text-ink-muted">{signal.detail}</p> : null}
                </div>
                <div className="shrink-0 text-right">
                  <Status tone={signal.strength === 3 ? "accent" : signal.strength === 2 ? "blue" : "neutral"}>
                    {signal.kind.replaceAll("_", " ")}
                  </Status>
                  <p className="text-[11px] text-ink-faint">{relativeTime(signal.observedAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No signals yet.</Empty>
        )}
      </Section>

      <Section title={`People (${data.people.length})`} description="Enroll someone to draft their first message onto Today. Guessed emails (first@domain) are unverified — check before sending.">
        {data.people.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {data.people.map((person) => (
              <PersonRow
                key={person.id}
                person={person}
                messages={data.messages.filter((message) => message.personId === person.id)}
                campaigns={campaigns}
                apollo={apollo}
              />
            ))}
          </ul>
        ) : (
          <Empty>No people yet. Use Find people, or add someone below.</Empty>
        )}
        <AddPerson companyId={company.id} />
      </Section>
    </div>
  );
}

function PersonRow({
  person,
  messages,
  campaigns,
  apollo,
}: {
  person: Person;
  messages: Message[];
  campaigns: { id: string; name: string }[];
  apollo: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(person.email ?? "");
  const [linkedinUrl, setLinkedinUrl] = useState(person.linkedinUrl ?? "");
  const [open, setOpen] = useState(false);

  const act = (work: () => Promise<{ ok: true } | { ok: false; error: string }>, success?: string) =>
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return void toast.error(result.error);
      if (success) toast.success(success);
      router.refresh();
    });

  const sent = messages.filter((m) => m.status === "sent" || m.status === "received");

  return (
    <li className="py-3">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="text-[14px] font-medium">
            {person.name}
            {person.title ? <span className="font-normal text-ink-muted"> · {person.title}</span> : null}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
            <Status tone={STAGE_TONE[person.stage]}>
              {person.stage}
              {person.closedReason ? ` (${person.closedReason.replaceAll("_", " ")})` : ""}
            </Status>
            {person.email ? (
              <span className="inline-flex items-center gap-1">
                <Mail className="size-3" aria-hidden="true" />
                {person.email}
                {person.emailStatus === "guessed" ? <span className="text-warning">· guessed</span> : null}
                {person.emailStatus === "bounced" ? <span className="text-danger">· bounced</span> : null}
              </span>
            ) : (
              <span>no email</span>
            )}
            {person.linkedinUrl ? (
              <a href={person.linkedinUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                <UserRound className="size-3" aria-hidden="true" />
                LinkedIn
              </a>
            ) : null}
            {person.twitterUrl ? (
              <a href={person.twitterUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                <AtSign className="size-3" aria-hidden="true" />
                X
              </a>
            ) : null}
            {sent.length ? (
              <button type="button" className="underline-offset-2 hover:underline" onClick={() => setOpen(!open)}>
                {sent.length} message{sent.length === 1 ? "" : "s"}
              </button>
            ) : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {person.stage === "new" && campaigns.length ? (
            <>
              <Select aria-label="Campaign" value={campaignId} onChange={(event) => setCampaignId(event.target.value)} className="h-8 w-auto text-[12px]">
                {campaigns.map((campaign) => (
                  <option key={campaign.id} value={campaign.id}>
                    {campaign.name}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="primary"
                disabled={pending || !campaignId}
                onClick={() => act(() => enrollAction([person.id], campaignId).then((r) => (r.ok ? { ok: true as const } : r)), "Enrolled — draft is on Today")}
              >
                Enroll
              </Button>
            </>
          ) : null}
          {person.stage === "active" ? (
            <Button size="sm" disabled={pending} onClick={() => act(() => updatePersonAction(person.id, { stage: "closed" }).then((r) => (r.ok ? { ok: true as const } : r)), "Sequence stopped")}>
              Stop
            </Button>
          ) : null}
          {apollo && person.emailStatus !== "found" ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                act(
                  () => revealEmailAction(person.id).then((r) => (r.ok ? { ok: true as const } : r)),
                  "Checked Apollo",
                )
              }
            >
              Find email
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
            Edit
          </Button>
        </div>
      </div>
      {editing ? (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            act(() => updatePersonAction(person.id, { email, linkedinUrl }).then((r) => (r.ok ? { ok: true as const } : r)), "Saved");
            setEditing(false);
          }}
        >
          <Field label="Email">
            <Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" />
          </Field>
          <Field label="LinkedIn URL">
            <Input value={linkedinUrl} onChange={(event) => setLinkedinUrl(event.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={pending}>
            Save
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => act(() => deletePersonAction(person.id).then((r) => (r.ok ? { ok: true as const } : r)), "Removed")}
          >
            Remove
          </Button>
        </form>
      ) : null}
      {open ? (
        <ol className="mt-3 space-y-2 border-l border-line pl-4">
          {sent.map((message) => (
            <li key={message.id} className="text-[13px]">
              <p className="text-[12px] text-ink-muted">
                {message.direction === "in" ? "Reply" : CHANNEL_LABELS[message.channel]} · {relativeTime(message.sentAt)}
              </p>
              {message.subject ? <p className="font-medium">{message.subject}</p> : null}
              <p className="whitespace-pre-wrap text-ink-muted">{message.body}</p>
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}

function AddPerson({ companyId }: { companyId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({ name: "", title: "", email: "", linkedinUrl: "" });
  if (!open) {
    return (
      <Button size="sm" variant="ghost" className="mt-3" onClick={() => setOpen(true)}>
        <Plus className="size-3.5" aria-hidden="true" />
        Add person
      </Button>
    );
  }
  return (
    <form
      className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await addPersonAction(companyId, form);
          if (!result.ok) return void toast.error(result.error);
          setForm({ name: "", title: "", email: "", linkedinUrl: "" });
          setOpen(false);
          router.refresh();
        });
      }}
    >
      {(["name", "title", "email", "linkedinUrl"] as const).map((key) => (
        <Field key={key} label={{ name: "Name", title: "Title", email: "Email", linkedinUrl: "LinkedIn URL" }[key]}>
          <Input
            value={form[key]}
            required={key === "name"}
            onChange={(event) => setForm({ ...form, [key]: event.target.value })}
          />
        </Field>
      ))}
      <Button type="submit" variant="primary" disabled={pending}>
        Add
      </Button>
    </form>
  );
}
