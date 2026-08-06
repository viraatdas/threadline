import type { PersonRecord } from "@/components/people/types";

// A project is a named, plain-language definition of who you want to reach —
// "who would care about this?". Unlike a campaign (deterministic keyword
// overlap, computed in the browser), a project is matched by a light LLM that
// reads each contact's role and recent context and decides relevance. Projects
// and their verdicts live in localStorage; matching runs through an owner-only
// server action.

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
}

export interface ProjectVerdict {
  match: boolean;
  confidence: number;
  reason: string;
  at: string;
}

// One contact handed to the matcher.
export interface ProjectMatchCandidate {
  id: string;
  name: string;
  title?: string | null;
  company?: string | null;
  digest?: string | null;
  context?: string | null;
}

// One verdict returned by the matcher (no timestamp — added on the client).
export interface ProjectMatchOutcome {
  id: string;
  match: boolean;
  confidence: number;
  reason: string;
}

// The owner-only server action, threaded in as a prop so the client board never
// statically imports server-only modules (keeps it renderable in tests/demo).
export type MatchProjectAction = (payload: {
  name: string;
  description: string;
  contacts: ProjectMatchCandidate[];
}) => Promise<
  | { ok: true; data: { verdicts: ProjectMatchOutcome[] } }
  | { ok: false; error: string }
>;

export const PROJECT_STORAGE_KEY = "threadline.projects.v1";
export const PROJECT_MATCH_STORAGE_KEY = "threadline.project-matches.v1";

// The starter project. Seeded once so the board opens with a working example
// the owner can rename, edit, or delete.
export const SEED_PROJECT: Project = {
  id: "libra",
  name: "Libra",
  description:
    "Libra is an SRE agent that autonomously finds and fixes production " +
    "bugs, then validates each fix in an isolated PR sandbox before opening a " +
    "pull request. I want to reach SREs, platform and infrastructure " +
    "engineers, on-call and incident-response leads, and people building or " +
    "buying developer tooling, CI/CD, observability, or reliability products.",
  createdAt: "2026-01-01T00:00:00.000Z",
};

type VerdictMap = Record<string, ProjectVerdict>;

function isProject(value: unknown): value is Project {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Project).id === "string" &&
    typeof (value as Project).name === "string" &&
    typeof (value as Project).description === "string"
  );
}

export function loadProjects(): Project[] {
  if (typeof window === "undefined") return [SEED_PROJECT];
  try {
    const raw = window.localStorage.getItem(PROJECT_STORAGE_KEY);
    if (raw === null) {
      // First visit: seed the starter project so nothing opens blank.
      saveProjects([SEED_PROJECT]);
      return [SEED_PROJECT];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProject);
  } catch {
    return [SEED_PROJECT];
  }
}

export function saveProjects(projects: Project[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Storage full or blocked — projects stay session-local.
  }
}

// Verdicts are cached per (project, person) so re-opening a project is instant
// and never re-pays for a classification that hasn't changed.
export function loadVerdicts(projectId: string): VerdictMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(PROJECT_MATCH_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (typeof parsed !== "object" || parsed === null) return {};
    const forProject = (parsed as Record<string, unknown>)[projectId];
    if (typeof forProject !== "object" || forProject === null) return {};
    return forProject as VerdictMap;
  } catch {
    return {};
  }
}

export function saveVerdicts(projectId: string, verdicts: VerdictMap): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(PROJECT_MATCH_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    const all =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, VerdictMap>)
        : {};
    all[projectId] = verdicts;
    window.localStorage.setItem(PROJECT_MATCH_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Ignore — verdicts simply won't persist across reloads.
  }
}

// The compact context handed to the model for one person: recent subjects and
// snippets, plus the cheap-model digest if present. No full message bodies.
export function contextForPerson(person: PersonRecord): string {
  const lines = person.recentMessages
    .slice(0, 4)
    .map((message) => `${message.subject} ${message.snippet}`.trim())
    .filter(Boolean);
  return lines.join(" · ").slice(0, 1000);
}
