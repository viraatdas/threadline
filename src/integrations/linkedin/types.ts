import { z } from "zod";

export const LINKEDIN_RISK_NOTICE =
  "Linked API is an unofficial, unaffiliated LinkedIn integration. Threadline only reads mirrored data; sending messages, invitations, connection requests, profile views, reactions, and posts is disabled.";

export const LINKEDIN_READ_ONLY_OPERATIONS = [
  "syncInbox",
  "syncConversation",
  "fetchPerson",
  "fetchCompany",
] as const;

export const linkedinOperationNameSchema = z.enum(LINKEDIN_READ_ONLY_OPERATIONS);
export type LinkedinOperationName = z.infer<typeof linkedinOperationNameSchema>;

export const linkedinCredentialsSchema = z.object({
  linkedApiToken: z.string().trim().min(1),
  identificationToken: z.string().trim().min(1),
});

export type LinkedinCredentials = z.infer<typeof linkedinCredentialsSchema>;

export const linkedinMessageSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(["st", "nv"]).default("st"),
  threadId: z.string().trim().min(1),
  personUrl: z.string().trim().min(1),
  sender: z.enum(["us", "them"]),
  text: z.string(),
  time: z.string().datetime({ offset: true }),
});

export type LinkedinMessage = z.infer<typeof linkedinMessageSchema>;

export const linkedinConversationMessageSchema = linkedinMessageSchema
  .omit({ type: true, personUrl: true })
  .extend({ threadId: z.string().trim().nullable() });

export const linkedinInboxResultSchema = z.object({
  messages: z.array(linkedinMessageSchema),
});

export const linkedinConversationPollResultSchema = z.object({
  personUrl: z.string().trim().min(1),
  since: z.string().datetime({ offset: true }).optional(),
  type: z.enum(["st", "nv"]),
  messages: z.array(linkedinConversationMessageSchema),
});

export type LinkedinConversationPollResult = z.infer<
  typeof linkedinConversationPollResultSchema
>;

export const linkedinPersonSchema = z
  .object({
    name: z.string().trim().min(1),
    publicUrl: z.string().trim().min(1),
    hashedUrl: z.string().trim().optional().default(""),
    headline: z.string().optional().default(""),
    location: z.string().optional().default(""),
    countryCode: z.string().optional().default(""),
    position: z.string().optional().default(""),
    companyName: z.string().optional().default(""),
    companyHashedUrl: z.string().optional().default(""),
    followersCount: z.number().nullable().optional().default(null),
    about: z.string().nullable().optional().default(null),
    experiences: z
      .array(
        z.object({
          position: z.string().optional().default(""),
          companyName: z.string().optional().default(""),
          companyHashedUrl: z.string().optional().default(""),
          employmentType: z.string().optional().default(""),
          locationType: z.string().optional().default(""),
          description: z.string().optional().default(""),
          duration: z.number().optional().default(0),
          startTime: z.string().optional().default(""),
          endTime: z.string().nullable().optional().default(null),
          location: z.string().optional().default(""),
        }),
      )
      .optional()
      .default([]),
  })
  .passthrough();

export type LinkedinPerson = z.infer<typeof linkedinPersonSchema>;

export const linkedinCompanySchema = z
  .object({
    name: z.string().trim().min(1),
    publicUrl: z.string().trim().min(1),
    description: z.string().optional().default(""),
    location: z.string().optional().default(""),
    headquarters: z.string().optional().default(""),
    industry: z.string().optional().default(""),
    specialties: z.string().optional().default(""),
    website: z.string().optional().default(""),
    employeesCount: z.number().optional().default(0),
    yearFounded: z.number().optional(),
    ventureFinancing: z.boolean().optional().default(false),
    jobsCount: z.number().optional().default(0),
  })
  .passthrough();

export type LinkedinCompany = z.infer<typeof linkedinCompanySchema>;

export interface LinkedinProfileEnrichment {
  person?: LinkedinPerson | undefined;
  company?: LinkedinCompany | undefined;
  pendingWorkflows?: readonly WorkflowReference[] | undefined;
}

export interface WorkflowReference {
  workflowId: string;
  operationName: LinkedinOperationName;
  status: "pending" | "running";
  message?: string | undefined;
}

export interface WorkflowCompleted<TResult> {
  status: "completed";
  workflowId: string;
  operationName: LinkedinOperationName;
  data: TResult;
}

export type WorkflowResult<TResult> = WorkflowReference | WorkflowCompleted<TResult>;

export interface LinkedinCursor {
  since?: string | undefined;
  offset: number;
}

export interface LinkedinConnectionStatus {
  ok: boolean;
  state: "connected" | "setup_required" | "attention_required";
  detail: string;
}
