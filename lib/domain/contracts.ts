import type {
  AnalysisJobInput,
  AnalysisResultInput,
  ReadOnlyCapabilities,
  SyncPage,
} from "@/lib/domain/schemas";
import type { Channel } from "@/lib/domain/constants";

export interface ConnectorContext {
  integrationAccountId: string;
  signal?: AbortSignal;
  now: Date;
}

export interface ConnectorHealth {
  ok: boolean;
  checkedAt: Date;
  accountLabel?: string;
  detail?: string;
}

export interface PullRequest {
  resource: string;
  cursor?: string;
  since?: Date;
  limit?: number;
}

export interface ChannelConnector {
  readonly channel: Channel;
  readonly capabilities: ReadOnlyCapabilities;
  checkConnection(context: ConnectorContext): Promise<ConnectorHealth>;
  pull(context: ConnectorContext, request: PullRequest): AsyncIterable<SyncPage>;
}

export interface AnalysisRunnerHealth {
  ok: boolean;
  runner: string;
  detail?: string;
}

export interface AnalysisRunner {
  readonly name: string;
  checkHealth(signal?: AbortSignal): Promise<AnalysisRunnerHealth>;
  run(job: AnalysisJobInput, signal?: AbortSignal): Promise<AnalysisResultInput>;
}

export interface CredentialVault {
  seal(value: unknown, context: string): Promise<string>;
  open<T>(envelope: string, context: string): Promise<T>;
}

export interface DomainClock {
  now(): Date;
}

export const systemClock: DomainClock = {
  now: () => new Date(),
};
