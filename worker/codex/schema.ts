import { z } from "zod";

import { analysisResultInputSchema, sourceProvenanceSchema } from "../../lib/domain/schemas";

const nullableTrimmedString = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();

export const classificationOutputSchema = z
  .object({
    isCustomerOutreach: z.boolean(),
    person: z
      .object({
        displayName: nullableTrimmedString(255),
        givenName: nullableTrimmedString(120),
        familyName: nullableTrimmedString(120),
        email: z.string().email().nullable(),
        linkedinUrl: z.string().url().nullable(),
        xHandle: nullableTrimmedString(255),
      })
      .strict(),
    company: z
      .object({
        name: nullableTrimmedString(255),
        domain: z
          .string()
          .trim()
          .toLowerCase()
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
          .nullable(),
      })
      .strict(),
    role: z
      .object({
        title: nullableTrimmedString(255),
        seniority: nullableTrimmedString(120),
      })
      .strict(),
    relationshipStage: z.enum([
      "unreviewed",
      "planned",
      "active",
      "waiting",
      "replied",
      "dormant",
      "closed",
    ]),
    reply: z
      .object({
        detected: z.boolean(),
        state: z.enum(["unknown", "awaiting_reply", "replied", "not_applicable"]),
        latestReplyAt: z.string().datetime({ offset: true }).nullable(),
      })
      .strict(),
    sentiment: z.enum(["positive", "neutral", "negative", "mixed", "unknown"]),
    intent: z.enum([
      "prospecting",
      "partnership",
      "support",
      "hiring",
      "investor",
      "networking",
      "other",
      "unknown",
    ]),
    nextAction: z
      .object({
        recommendation: z.enum([
          "follow_up",
          "wait_for_reply",
          "respond",
          "research",
          "schedule_meeting",
          "close_loop",
          "none",
        ]),
        followUpAt: z.string().datetime({ offset: true }).nullable(),
        summary: z.string().trim().min(1).max(500),
      })
      .strict(),
    rationale: z.string().trim().min(1).max(800),
    confidence: z.number().min(0).max(1),
    evidenceMessageIds: z.array(z.string().uuid()).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.reply.detected !== (value.reply.state === "replied")) {
      context.addIssue({
        code: "custom",
        message: "reply.detected must agree with reply.state.",
        path: ["reply", "detected"],
      });
    }

    if (!value.reply.detected && value.reply.latestReplyAt !== null) {
      context.addIssue({
        code: "custom",
        message: "latestReplyAt must be null when no reply was detected.",
        path: ["reply", "latestReplyAt"],
      });
    }

    if (value.nextAction.recommendation === "follow_up" && value.nextAction.followUpAt === null) {
      context.addIssue({
        code: "custom",
        message: "followUpAt is required for follow_up recommendations.",
        path: ["nextAction", "followUpAt"],
      });
    }
  });

export const draftOutreachOutputSchema = z
  .object({
    text: z.string().trim().min(1).max(100_000),
    confidence: z.number().min(0).max(1),
    evidenceMessageIds: z.array(z.string().uuid()).max(64),
  })
  .strict();

export const classificationWorkerAnalysisResultSchema = analysisResultInputSchema.extend({
  resultType: z.literal("outreach_classification"),
  result: classificationOutputSchema,
});

export const draftWorkerAnalysisResultSchema = analysisResultInputSchema.extend({
  resultType: z.literal("outreach_draft"),
  result: draftOutreachOutputSchema,
});

export const workerAnalysisResultSchema = z.discriminatedUnion("resultType", [
  classificationWorkerAnalysisResultSchema,
  draftWorkerAnalysisResultSchema,
]);

export const workerAnalysisEnvelopeSchema = z
  .object({
    jobId: z.string().uuid(),
    context: z
      .object({
        channel: z.enum(["gmail", "linkedin", "x"]).optional(),
        conversationId: z.string().uuid().optional(),
        subject: z.string().optional(),
        participants: z.array(
          z
            .object({
              externalParticipantId: z.string(),
              role: z.enum(["owner", "contact", "other"]),
              displayName: z.string().optional(),
              address: z.string().optional(),
              contactId: z.string().uuid().optional(),
              identityId: z.string().uuid().optional(),
            })
            .strict(),
        ),
        messages: z.array(
          z
            .object({
              id: z.string().uuid(),
              channel: z.enum(["gmail", "linkedin", "x"]),
              direction: z.enum(["inbound", "outbound", "system", "unknown"]),
              sentAt: z.string().datetime({ offset: true }),
              subject: z.string().optional(),
              bodyText: z.string().optional(),
              snippet: z.string().optional(),
            })
            .strict(),
        ),
        entitySnapshot: z.record(z.string(), z.unknown()),
        evidence: z.array(sourceProvenanceSchema),
      })
      .strict(),
  })
  .strict();

export type ClassificationOutput = z.infer<typeof classificationOutputSchema>;
export type DraftOutreachOutput = z.infer<typeof draftOutreachOutputSchema>;
export type WorkerAnalysisResult = z.infer<typeof workerAnalysisResultSchema>;

export function parseClassificationOutput(value: unknown): ClassificationOutput {
  return classificationOutputSchema.parse(value);
}

export function parseDraftOutreachOutput(value: unknown): DraftOutreachOutput {
  return draftOutreachOutputSchema.parse(value);
}

const injectedInstructionPatterns = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/iu,
  /(?:auth\.json|openai_api_key|codex_access_token|database_url|\/data\/codex)/iu,
  /<\/?(?:system|developer|assistant|tool|function)(?:\s|>)/iu,
  /\b(?:toolcall|shell command|execute command|run command)\b/iu,
];

export function assertNoInjectedInstructions(
  output: ClassificationOutput | DraftOutreachOutput,
): void {
  const narrative =
    "text" in output ? output.text : [output.nextAction.summary, output.rationale].join("\n");
  if (injectedInstructionPatterns.some((pattern) => pattern.test(narrative))) {
    throw new Error("Model-authored text contains injected instruction or secret-access text.");
  }
}
