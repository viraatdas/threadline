"use client";

import { AtSign, GitBranch, Newspaper, ClipboardList, Search, Terminal, Sparkles } from "lucide-react";
import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";

import { findAction, researchAction } from "@/app/(app)/actions";
import { Button, Input, Status, Textarea } from "@/components/ui";

type Summary = {
  companies: number;
  newCompanies: number;
  people: number;
  newPeople: number;
  signals: number;
  companyIds: string[];
  warnings: string[];
};

const YC_PRESETS = [
  "iOS, mobile app, App Store",
  "macOS, desktop app, Mac app",
  "computer use, browser agent, desktop agent",
  "developer tools, CI/CD, build infrastructure",
];

export function Find({ availability }: { availability: { github: boolean; linkedin: boolean; apollo: boolean } }) {
  return (
    <div>
      <div className="border-b border-line pb-6">
        <h1 className="text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">Find</h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-6 text-ink-muted">
          Pull in companies that look like they need a Mac for CI or agents. Every source adds companies with the evidence
          that surfaced them; nothing is contacted until you enroll someone and approve the message.
        </p>
      </div>

      <div className="divide-y divide-line">
        <YcDirectory />
        <SourceRow
          icon={<GitBranch className="size-4" aria-hidden="true" />}
          title="GitHub macOS CI"
          description="Organizations whose GitHub Actions run on macOS runners or call xcodebuild/fastlane. The strongest signal: they pay for Mac CI today."
        >
          {availability.github ? (
            <RunButton label="Scan workflows" run={() => findAction({ source: "github", maxOrgs: 30 })} />
          ) : (
            <p className="text-[13px] text-ink-muted">
              Needs a GitHub token (read-only, public repos).{" "}
              <Link href="/settings#keys" className="font-medium text-accent-strong hover:underline">
                Add one in Settings
              </Link>{" "}
              or run <code className="rounded bg-surface-subtle px-1">pnpm scout github</code> locally.
            </p>
          )}
        </SourceRow>
        <HackerNews />
        <SourceRow
          icon={<AtSign className="size-4" aria-hidden="true" />}
          title="X posts (bird)"
          description={
            <>
              People posting about slow macOS runners, Xcode Cloud, or buying Mac minis for agents. Runs on your Mac with{" "}
              <code className="rounded bg-surface-subtle px-1">bird</code>, which uses your browser&apos;s x.com login, so
              no X credentials are stored here. Each poster becomes a prospect you can DM from Today.
            </>
          }
        >
          <pre className="overflow-x-auto rounded-[8px] bg-surface-subtle px-3 py-2 text-[12px] leading-5 text-ink-muted">
            {`npm i -g @jtsang/bird@0.8.1 && bird whoami
pnpm scout x                      # default Mac-pain searches
pnpm scout x "xcode cloud slow"   # your own (comma-separated)`}
          </pre>
        </SourceRow>
        <YcCli />
        <Manual />
      </div>
    </div>
  );
}

function SourceRow({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 py-7 lg:grid-cols-[300px_1fr] lg:gap-10">
      <div>
        <h2 className="flex items-center gap-2 text-[15px] font-semibold">
          <span className="grid size-7 place-items-center rounded-[7px] bg-surface-subtle text-ink">{icon}</span>
          {title}
        </h2>
        <p className="mt-2 text-[13px] leading-5 text-ink-muted">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function useFind() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pending, startTransition] = useTransition();
  const run = (work: () => ReturnType<typeof findAction>) =>
    startTransition(async () => {
      const result = await work();
      if (!result.ok) return void toast.error(result.error);
      setSummary(result.data);
      if (result.data.companies === 0) toast.message("Nothing new matched.");
    });
  return { summary, pending, run };
}

function RunButton({ label, run: work }: { label: string; run: () => ReturnType<typeof findAction> }) {
  const { summary, pending, run } = useFind();
  return (
    <div className="space-y-3">
      <Button variant="primary" onClick={() => run(work)} disabled={pending}>
        <Search className="size-3.5" aria-hidden="true" />
        {pending ? "Searching… (up to a minute)" : label}
      </Button>
      <Result summary={summary} />
    </div>
  );
}

function YcDirectory() {
  const [query, setQuery] = useState(YC_PRESETS[0]!);
  const { summary, pending, run } = useFind();
  return (
    <SourceRow
      icon={<Sparkles className="size-4" aria-hidden="true" />}
      title="YC companies"
      description="Search all active YC companies by what they build. Comma-separate phrases. Founders (with LinkedIn) are pulled when you open a company and Find people."
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => findAction({ source: "yc", query, limit: 40 }));
        }}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="YC search phrases" />
          <Button type="submit" variant="primary" disabled={pending || query.trim().length < 2}>
            {pending ? "Searching…" : "Search YC"}
          </Button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {YC_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setQuery(preset)}
              className="rounded-[6px] border border-line px-2 py-1 text-[12px] text-ink-muted hover:border-line-strong hover:text-ink"
            >
              {preset}
            </button>
          ))}
        </div>
      </form>
      <Result summary={summary} />
    </SourceRow>
  );
}

function HackerNews() {
  const [query, setQuery] = useState("");
  const { summary, pending, run } = useFind();
  return (
    <SourceRow
      icon={<Newspaper className="size-4" aria-hidden="true" />}
      title="Hacker News"
      description="Launches and posts from the last year about macOS runners, iOS CI, Xcode Cloud, Mac minis and computer-use agents — kept only when they link to a company site."
    >
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          run(() => findAction({ source: "hn", query }));
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Default pain-point searches, or your own, comma-separated"
          aria-label="Hacker News searches"
        />
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? "Searching…" : "Search HN"}
        </Button>
      </form>
      <Result summary={summary} />
    </SourceRow>
  );
}

function YcCli() {
  const [json, setJson] = useState("");
  const { summary, pending, run } = useFind();
  return (
    <SourceRow
      icon={<Terminal className="size-4" aria-hidden="true" />}
      title="YC CLI (Bookface)"
      description={
        <>
          Uses your own <code className="rounded bg-surface-subtle px-1">yc</code> login, so Bookface search (and founder
          emails where Bookface has them) stays on your machine. Run{" "}
          <code className="rounded bg-surface-subtle px-1">pnpm scout yc &quot;ios ci&quot;</code> to push results here
          directly, or paste JSON output.
        </>
      }
    >
      <div className="space-y-3">
        <pre className="overflow-x-auto rounded-[8px] bg-surface-subtle px-3 py-2 text-[12px] leading-5 text-ink-muted">
          {`yc tools run search.companies --input '{"queries":["ios app","mac ci"]}' --json`}
        </pre>
        <Textarea
          rows={5}
          value={json}
          onChange={(event) => setJson(event.target.value)}
          placeholder="Paste the JSON output here"
          aria-label="YC CLI JSON"
          className="font-mono text-[12px]"
        />
        <Button
          variant="primary"
          disabled={pending || json.trim().length < 2}
          onClick={() => run(() => findAction({ source: "yc_cli", json }))}
        >
          {pending ? "Importing…" : "Import"}
        </Button>
      </div>
      <Result summary={summary} />
    </SourceRow>
  );
}

function Manual() {
  const [text, setText] = useState("");
  const { summary, pending, run } = useFind();
  return (
    <SourceRow
      icon={<ClipboardList className="size-4" aria-hidden="true" />}
      title="Paste a list"
      description="One per line, any order: name, title, email, LinkedIn URL, company domain. Works with rows copied from Apollo or Clay exports."
    >
      <div className="space-y-3">
        <Textarea
          rows={5}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={"Jane Doe, CTO, jane@acme.dev, linkedin.com/in/janedoe\nacme.dev"}
          aria-label="Prospect list"
          className="font-mono text-[12px]"
        />
        <Button variant="primary" disabled={pending || text.trim().length < 3} onClick={() => run(() => findAction({ source: "manual", text }))}>
          {pending ? "Importing…" : "Import"}
        </Button>
      </div>
      <Result summary={summary} />
    </SourceRow>
  );
}

function Result({ summary }: { summary: Summary | null }) {
  const [researching, startResearch] = useTransition();
  if (!summary) return null;
  const research = () =>
    startResearch(async () => {
      const result = await researchAction(summary.companyIds.slice(0, 15));
      if (!result.ok) return void toast.error(result.error);
      toast.success(`Researched ${result.data.done} companies`);
      result.data.failures.slice(0, 3).forEach((failure) => toast.warning(failure));
    });
  return (
    <div className="mt-4 space-y-2 rounded-[8px] border border-line px-4 py-3 text-[13px]">
      <p>
        <span className="font-medium tabular-nums">{summary.newCompanies}</span> new companies (
        <span className="tabular-nums">{summary.companies}</span> matched) ·{" "}
        <span className="tabular-nums">{summary.newPeople}</span> new people ·{" "}
        <span className="tabular-nums">{summary.signals}</span> new signals
      </p>
      {summary.warnings.slice(0, 4).map((warning) => (
        <Status key={warning} tone="warning">
          {warning}
        </Status>
      ))}
      <div className="flex flex-wrap gap-2 pt-1">
        {summary.companyIds.length ? (
          <Button size="sm" onClick={research} disabled={researching}>
            {researching ? "Researching…" : `Research ${Math.min(15, summary.companyIds.length)} with AI`}
          </Button>
        ) : null}
        <Link
          href="/prospects?view=unresearched"
          className="inline-flex h-8 items-center px-2 text-[12px] font-medium text-accent-strong hover:underline"
        >
          Review in Prospects →
        </Link>
      </div>
    </div>
  );
}
