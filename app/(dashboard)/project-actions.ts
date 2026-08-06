"use server";

import { z } from "zod";

import { auth } from "@/lib/auth/auth";
import { isOwnerSession } from "@/lib/auth/owner";
import {
  classifyProjectMatches,
  ProjectMatchConfigError,
  type ProjectMatchVerdict,
} from "@/lib/ai/project-match";
import type { WorkspaceActionResult } from "@/components/workspace-actions";

const contactSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(255),
  title: z.string().max(255).nullish(),
  company: z.string().max(255).nullish(),
  digest: z.string().max(500).nullish(),
  context: z.string().max(1200).nullish(),
});

const requestSchema = z.object({
  name: z.string().trim().min(1, "Name the project.").max(120),
  description: z
    .string()
    .trim()
    .min(1, "Describe who the project is about.")
    .max(2000),
  // Cap the roster per call so a single classification can't run unbounded.
  contacts: z.array(contactSchema).min(1).max(120),
});

export type ProjectMatchActionResult = WorkspaceActionResult<{
  verdicts: ProjectMatchVerdict[];
}>;

// Owner-only. Classifies the supplied contacts against the project definition
// using the light model, and returns per-contact verdicts. Read-only: it never
// writes to the database or touches any provider.
export async function classifyProjectMatchesAction(
  payload: unknown,
): Promise<ProjectMatchActionResult> {
  const session = await auth();
  if (!isOwnerSession(session)) {
    return { ok: false, error: "Not authorized." };
  }

  const parsed = requestSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid request.",
    };
  }

  try {
    const verdicts = await classifyProjectMatches(parsed.data);
    return { ok: true, data: { verdicts } };
  } catch (error) {
    if (error instanceof ProjectMatchConfigError) {
      return { ok: false, error: error.message };
    }
    // Never surface raw provider errors (they can echo prompt content).
    return {
      ok: false,
      error: "Matching is unavailable right now. Please try again.",
    };
  }
}
