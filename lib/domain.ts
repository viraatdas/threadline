import { z } from "zod";

export const PERSON_STAGES = ["new", "active", "replied", "meeting", "closed"] as const;
export type PersonStage = (typeof PERSON_STAGES)[number];

export const COMPANY_STATUSES = ["new", "target", "archived"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const CHANNELS = ["email", "linkedin_invite", "linkedin_message", "x_dm"] as const;
export type Channel = (typeof CHANNELS)[number];
export const LINKEDIN_CHANNELS = ["linkedin_invite", "linkedin_message"] as const satisfies Channel[];

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: "Email",
  linkedin_invite: "LinkedIn invite",
  linkedin_message: "LinkedIn message",
  x_dm: "X DM",
};

export const campaignStepSchema = z.object({
  channel: z.enum(CHANNELS),
  // Days after the previous step was sent. Ignored for the first step.
  waitDays: z.number().int().min(0).max(60),
  guidance: z.string().trim().max(600).default(""),
});
export type CampaignStep = z.infer<typeof campaignStepSchema>;

export const settingsSchema = z.object({
  productName: z.string().trim().min(1).max(80),
  productUrl: z.string().trim().url(),
  pitch: z.string().trim().min(1).max(2000),
  icp: z.string().trim().min(1).max(2000),
  senderName: z.string().trim().min(1).max(120),
  // Appended to every email, never written by the model.
  signature: z.string().max(600),
  dailyEmailLimit: z.number().int().min(0).max(200),
  dailyLinkedinLimit: z.number().int().min(0).max(100),
  // 200 for free LinkedIn accounts, 300 with Premium.
  inviteNoteLimit: z.number().int().min(0).max(300),
});
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  productName: "Offstage",
  productUrl: "https://offstage.cloud",
  pitch: [
    "Offstage gives agents and CI their own Mac: real macOS sandboxes (Mac Studio M5 Max, 128 GB, macOS 27, Xcode 27.2) behind a small API and SDK.",
    "Agents get a Mac from one setup prompt in Claude Code, Codex, or Cursor; they can run xcodebuild, swift test, simctl, drive desktop apps, and take screenshots.",
    "For CI, change `runs-on` to `offstage-macos` in GitHub Actions; every job gets a fresh Mac that is wiped afterwards.",
    "$0.78/hour billed per second, no seats or minimums, queue time is free, $5 free credit with no card.",
  ].join("\n"),
  icp: [
    "Teams shipping iOS/macOS apps who run CI on GitHub-hosted macOS runners (slow, 10x minute multiplier) or babysit their own Mac minis.",
    "Companies building AI agents that need to build, test, or operate Apple-platform software, or computer-use agents that need a real desktop.",
    "Best contacts: founders, CTOs, heads of engineering/platform/mobile, iOS leads, DevOps/infra owners.",
  ].join("\n"),
  senderName: "Viraat",
  signature: "Viraat\nOffstage · https://offstage.cloud",
  dailyEmailLimit: 40,
  dailyLinkedinLimit: 20,
  inviteNoteLimit: 200,
};

export const DEFAULT_CAMPAIGN = {
  name: "Mac CI pain",
  angle:
    "They run iOS/macOS builds on GitHub-hosted macOS runners or their own Macs. Offstage is a drop-in `runs-on: offstage-macos` with a fresh M5 Max per job at $0.78/hr. Lead with the specific evidence we found (their workflow, their app, their launch).",
  steps: [
    { channel: "email", waitDays: 0, guidance: "Short first touch. Name the evidence, one sentence on Offstage, one low-friction ask." },
    { channel: "linkedin_invite", waitDays: 1, guidance: "Connection note, no pitch beyond one line. Under the note limit." },
    { channel: "email", waitDays: 3, guidance: "Reply in thread. Add one new concrete detail (price per build, setup is one line). Two sentences." },
    { channel: "linkedin_message", waitDays: 4, guidance: "Only if connected. Casual, one question." },
    { channel: "email", waitDays: 5, guidance: "Polite close-the-loop. Offer $5 free credit link. No guilt." },
  ] satisfies CampaignStep[],
};

// For people found through their own posts on X (`pnpm scout x`). X DMs are
// opened prefilled on Today and sent by the owner inside X.
export const X_CAMPAIGN = {
  name: "Saw your post on X",
  angle:
    "They posted about Mac build pain, Mac minis for agents, or macOS CI. Reply to what they actually said, as a fellow builder. Offstage gives them a fresh M5 Max per job or agent session, pay per second at $0.78/hr, `runs-on: offstage-macos` for CI.",
  steps: [
    { channel: "x_dm", waitDays: 0, guidance: "Reference their post in a few words. One line on Offstage. Ask if it would help." },
    { channel: "email", waitDays: 3, guidance: "Only if we have their email. Two sentences: the post, the offer." },
    { channel: "x_dm", waitDays: 5, guidance: "Short, friendly last nudge with one concrete detail (setup is one line). No guilt." },
  ] satisfies CampaignStep[],
};
