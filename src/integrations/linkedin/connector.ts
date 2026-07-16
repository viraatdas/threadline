import type {
  ChannelConnector,
  ConnectorContext,
  ConnectorHealth,
  PullRequest,
} from "@/lib/domain/contracts";
import type { SyncPage } from "@/lib/domain/schemas";
import { READ_ONLY_CAPABILITIES } from "@/lib/security/read-only";

import { LinkedApiClient } from "@/src/integrations/linkedin/client";
import {
  canonicalizeLinkedinUrl,
  decodeLinkedinCursor,
  normalizeLinkedinInbox,
} from "@/src/integrations/linkedin/normalize";
import {
  LINKEDIN_RISK_NOTICE,
  type LinkedinCompany,
  type LinkedinPerson,
  type LinkedinProfileEnrichment,
  type WorkflowReference,
} from "@/src/integrations/linkedin/types";
import { LinkedinWorkflowCoordinator } from "@/src/integrations/linkedin/workflow";

interface ConnectorOptions {
  ownerExternalId: string;
  workflowCoordinator: LinkedinWorkflowCoordinator;
  maxProfileEnrichments?: number | undefined;
}

export class LinkedinConnector implements ChannelConnector {
  readonly channel = "linkedin" as const;
  readonly capabilities = READ_ONLY_CAPABILITIES;
  private readonly maxProfileEnrichments: number;

  constructor(
    private readonly client: LinkedApiClient,
    private readonly options: ConnectorOptions,
  ) {
    this.maxProfileEnrichments = options.maxProfileEnrichments ?? 0;
  }

  async checkConnection(context: ConnectorContext): Promise<ConnectorHealth> {
    const status = await this.client.checkConnection(context.signal);
    return {
      ok: status.ok,
      checkedAt: context.now,
      accountLabel: this.options.ownerExternalId,
      detail: `${status.detail} ${LINKEDIN_RISK_NOTICE}`,
    };
  }

  async *pull(context: ConnectorContext, request: PullRequest): AsyncIterable<SyncPage> {
    if (request.resource !== "inbox") {
      throw new Error(`Unsupported LinkedIn resource: ${request.resource}.`);
    }

    const cursor = decodeLinkedinCursor(request.cursor);
    const since = request.since?.toISOString() ?? cursor.since;
    const messages = await this.client.pollInbox(
      { ...(since ? { since } : {}), type: "st" },
      context.signal,
    );
    const enrichments = await this.enrichProfiles(messages.map((message) => message.personUrl), context);
    const pages = normalizeLinkedinInbox(messages, {
      integrationAccountId: context.integrationAccountId,
      ownerExternalId: this.options.ownerExternalId,
      collectedAt: context.now,
      ...(request.cursor ? { cursor: request.cursor } : {}),
      ...(request.limit ? { limit: request.limit } : {}),
      enrichments,
    });

    for (const page of pages) yield page;
  }

  private async enrichProfiles(
    profileUrls: readonly string[],
    context: ConnectorContext,
  ): Promise<ReadonlyMap<string, LinkedinProfileEnrichment>> {
    if (this.maxProfileEnrichments === 0) return new Map();
    const canonicalUrls = [...new Set(profileUrls.map(canonicalizeLinkedinUrl).filter(Boolean))].slice(
      0,
      this.maxProfileEnrichments,
    );
    const enrichments = new Map<string, LinkedinProfileEnrichment>();

    for (const profileUrl of canonicalUrls) {
      const pendingWorkflows: WorkflowReference[] = [];
      let person: LinkedinPerson | undefined;
      let company: LinkedinCompany | undefined;
      const personResult = await this.options.workflowCoordinator.runOnce<LinkedinPerson>({
        key: `profile:${profileUrl}`,
        operationName: "fetchPerson",
        start: () => this.client.startFetchPerson(profileUrl, context.signal),
        ...(context.signal ? { signal: context.signal } : {}),
      });

      if (personResult.status === "completed") {
        person = personResult.data;
      } else {
        pendingWorkflows.push(personResult);
      }

      const companyUrl = person?.companyHashedUrl;
      if (companyUrl) {
        const companyResult = await this.options.workflowCoordinator.runOnce<LinkedinCompany>({
          key: `company:${companyUrl}`,
          operationName: "fetchCompany",
          start: () => this.client.startFetchCompany(companyUrl, context.signal),
          ...(context.signal ? { signal: context.signal } : {}),
        });
        if (companyResult.status === "completed") {
          company = companyResult.data;
        } else {
          pendingWorkflows.push(companyResult);
        }
      }

      enrichments.set(profileUrl, {
        ...(person ? { person } : {}),
        ...(company ? { company } : {}),
        ...(pendingWorkflows.length > 0 ? { pendingWorkflows } : {}),
      });
    }

    return enrichments;
  }
}
