import type { Channel } from "@/lib/domain/constants";

export interface WorkspaceActionFailure {
  ok: false;
  error: string;
}

export interface WorkspaceActionSuccess<TData> {
  ok: true;
  data: TData;
}

export type WorkspaceActionResult<TData = Record<string, never>> =
  | WorkspaceActionSuccess<TData>
  | WorkspaceActionFailure;

export interface MutationReceipt {
  actorEmail: string;
  occurredAt: string;
}

export interface ContactMutationReceipt extends MutationReceipt {
  contactId: string;
}

export interface AddContactReceipt extends ContactMutationReceipt {
  companyId: string | null;
}

export interface MergeContactsReceipt extends MutationReceipt {
  sourceContactId: string;
  targetContactId: string;
}

export interface CompanyMutationReceipt extends MutationReceipt {
  companyId: string;
}

export interface PlanMutationReceipt extends MutationReceipt {
  planId: string;
  nextTouchAt: string | null;
}

export interface DraftRetryReceipt extends MutationReceipt {
  jobId: string;
  planId: string;
  scheduledAt: string;
}

export type ContactCorrectionField = "title" | "company" | "location";
export type CompanyCorrectionField = "industry" | "sizeRange" | "location";

export type AddContactAction = (
  formData: FormData,
) => Promise<WorkspaceActionResult<AddContactReceipt>>;

export type EditContactAction = (
  contactId: string,
  formData: FormData,
) => Promise<WorkspaceActionResult<ContactMutationReceipt>>;

export type CorrectContactAction = (
  contactId: string,
  field: ContactCorrectionField,
  formData: FormData,
) => Promise<WorkspaceActionResult<ContactMutationReceipt>>;

export type MergeContactsAction = (
  sourceContactId: string,
  targetContactId: string,
) => Promise<WorkspaceActionResult<MergeContactsReceipt>>;

export type EditCompanyAction = (
  companyId: string,
  formData: FormData,
) => Promise<WorkspaceActionResult<CompanyMutationReceipt>>;

export type CorrectCompanyAction = (
  companyId: string,
  field: CompanyCorrectionField,
  formData: FormData,
) => Promise<WorkspaceActionResult<CompanyMutationReceipt>>;

export type UpsertOutreachPlanAction = (
  contactId: string,
  planId: string | null,
  formData: FormData,
) => Promise<WorkspaceActionResult<PlanMutationReceipt>>;

export type RescheduleOutreachPlanAction = (
  planId: string,
  formData: FormData,
) => Promise<WorkspaceActionResult<PlanMutationReceipt>>;

export type CompleteOutreachPlanAction = (
  planId: string,
) => Promise<WorkspaceActionResult<PlanMutationReceipt>>;

export type RetryOutreachDraftAction = (
  planId: string,
) => Promise<WorkspaceActionResult<DraftRetryReceipt>>;

export function workspaceActionError(
  result: WorkspaceActionResult<unknown>,
  fallback: string,
): string | null {
  return result.ok ? null : result.error || fallback;
}

export function isWorkspaceChannel(value: string): value is Channel {
  return value === "gmail" || value === "linkedin" || value === "x";
}
