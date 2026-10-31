import type { Company, Person } from "@/lib/db/schema";
import { readInTouch } from "@/lib/domain";

// Who to contact first. A person's score is their company's fit (from
// research), how close their role is to the CI decision, and whether we can
// reach them, adjusted by what replies have shown so far. Every factor comes
// back as a plain reason so the owner can see why someone ranks where they do.

export const STAKEHOLDERS = ["decider", "champion", "user", "other", "unknown"] as const;
export type Stakeholder = (typeof STAKEHOLDERS)[number];

export const STAKEHOLDER_LABELS: Record<Stakeholder, string> = {
  decider: "Decision maker",
  champion: "Champion",
  user: "Hands-on",
  other: "Other role",
  unknown: "Role unknown",
};

const TECH = /engineer|engineering|developer|\bdev\b|ios|macos|mobile|swift|platform|infra|devops|\bsre\b|build|release|\bci\b|\bqa\b|quality|test|technical|technology/i;

export function stakeholderOf(title: string | null | undefined): Stakeholder {
  if (!title?.trim()) return "unknown";
  if (/founder|\bceo\b|\bcto\b|chief (technology|technical|executive|product) officer|\bpresident\b/i.test(title)) return "decider";
  if (/\bvp\b|vice president/i.test(title) && TECH.test(title)) return "decider";
  if (/head|director|lead|manager|principal|staff|architect/i.test(title) && TECH.test(title)) return "champion";
  if (TECH.test(title)) return "user";
  return "other";
}

const ROLE: Record<Stakeholder, { weight: number; reason: string }> = {
  decider: { weight: 1, reason: "can decide on CI spend" },
  champion: { weight: 0.9, reason: "owns the build pain and can bring it to a decider" },
  user: { weight: 0.65, reason: "feels slow Mac builds daily; a likely champion" },
  other: { weight: 0.25, reason: "role is far from CI" },
  unknown: { weight: 0.5, reason: "no title yet" },
};

export interface RankInput {
  title: string | null;
  email: string | null;
  emailStatus: "found" | "guessed" | "bounced" | null;
  linkedinUrl: string | null;
  company: { name: string; score: number | null; hook: string | null; fitSummary: string | null; targetTitles: string[] } | null;
  inTouch: boolean;
}

export interface Rank {
  score: number;
  stakeholder: Stakeholder;
  reasons: string[];
}

export function rankPerson(input: RankInput, lifts: Lifts = {}): Rank {
  const stakeholder = stakeholderOf(input.title);
  const role = ROLE[stakeholder];
  // Research names the titles that buy at this company; a match counts as close to a decider.
  const targeted = Boolean(
    input.title &&
      input.company?.targetTitles.some((target) => {
        const a = target.toLowerCase();
        const b = input.title!.toLowerCase();
        return a.length > 1 && (b.includes(a) || a.includes(b));
      }),
  );
  const roleWeight = targeted ? Math.max(role.weight, 0.95) : role.weight;
  const reasons = [`${input.title?.trim() || STAKEHOLDER_LABELS[stakeholder]}: ${targeted && stakeholder !== "decider" ? "a title research says buys here" : role.reason}`];

  const fit = input.company?.score ?? 35;
  if (!input.company) reasons.push("no company on file");
  else if (input.company.score === null) reasons.push(`${input.company.name} isn't researched yet`);
  else {
    const why = clip(input.company.hook || input.company.fitSummary, 90);
    reasons.push(`${input.company.name} fit ${input.company.score}${why ? `: ${why}` : ""}`);
  }

  const usableEmail = input.email && input.emailStatus !== "bounced";
  const reach = usableEmail ? (input.emailStatus === "guessed" ? 0.8 : 1) : input.linkedinUrl ? 0.75 : 0.3;
  reasons.push(
    usableEmail
      ? input.emailStatus === "guessed"
        ? "email guessed, unverified"
        : "email found"
      : input.linkedinUrl
        ? "LinkedIn only"
        : input.emailStatus === "bounced"
          ? "email bounced, no other way to reach"
          : "no way to reach yet",
  );

  const lift = lifts[stakeholder];
  if (lift && lift.lift !== 1) {
    reasons.push(`${STAKEHOLDER_LABELS[stakeholder]}s reply ${lift.lift.toFixed(1)}× average so far (${lift.replied}/${lift.contacted})`);
  }
  if (input.inTouch) reasons.push("you're already in touch");

  return { score: Math.round(Math.min(100, fit * roleWeight * reach * (lift?.lift ?? 1))), stakeholder, reasons };
}

export function rankInputFor(
  person: Pick<Person, "title" | "email" | "emailStatus" | "linkedinUrl" | "metadata">,
  company: Pick<Company, "name" | "score" | "hook" | "fitSummary" | "metadata"> | null,
): RankInput {
  const titles = company?.metadata.targetTitles;
  return {
    title: person.title,
    email: person.email,
    emailStatus: person.emailStatus,
    linkedinUrl: person.linkedinUrl,
    company: company
      ? {
          name: company.name,
          score: company.score,
          hook: company.hook,
          fitSummary: company.fitSummary,
          targetTitles: Array.isArray(titles) ? titles.filter((title): title is string => typeof title === "string") : [],
        }
      : null,
    inTouch: Boolean(readInTouch(person.metadata)) && person.metadata.inTouchOverride !== true,
  };
}

// ── Learning from replies ────────────────────────────────────────────────────
// Reply rate per group, pulled toward the overall rate until there's enough
// data (PRIOR people's worth), so one early reply doesn't reorder everything.

export interface GroupStat {
  key: string;
  contacted: number;
  replied: number;
}
export type Lifts = Partial<Record<string, { lift: number; contacted: number; replied: number; rate: number }>>;

const PRIOR = 10;

export function learnLifts(groups: GroupStat[]): Lifts {
  const contacted = groups.reduce((sum, group) => sum + group.contacted, 0);
  const replied = groups.reduce((sum, group) => sum + group.replied, 0);
  if (!contacted || !replied) return {};
  const base = replied / contacted;
  const lifts: Lifts = {};
  for (const group of groups) {
    if (!group.contacted) continue;
    const smoothed = (group.replied + PRIOR * base) / (group.contacted + PRIOR);
    const lift = Math.round(Math.min(2, Math.max(0.5, smoothed / base)) * 10) / 10;
    lifts[group.key] = { lift, contacted: group.contacted, replied: group.replied, rate: group.replied / group.contacted };
  }
  return lifts;
}

function clip(value: string | null | undefined, max: number) {
  const text = value?.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
