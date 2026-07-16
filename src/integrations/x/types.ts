import type { ConnectorHealth } from "@/lib/domain/contracts";

export const X_DM_RESOURCE = "direct_messages";

export interface XCredentials {
  authToken: string;
  ct0: string;
}

export interface XAccountIdentity {
  id: string;
  username: string;
  name?: string;
}

export interface BirdDmUser {
  id: string;
  username?: string;
  name?: string;
  profileImageUrl?: string;
}

export interface BirdDmEvent {
  id: string;
  conversationId?: string;
  text?: string;
  createdAt?: string;
  senderId?: string;
  recipientId?: string;
  sender?: BirdDmUser;
  recipient?: BirdDmUser;
  replyToEventId?: string;
  inboxKind?: "accepted" | "request";
  isMessageRequest?: boolean;
  unavailable?: boolean;
  raw?: unknown;
}

export interface BirdDmConversation {
  id: string;
  participants: BirdDmUser[];
  messages: BirdDmEvent[];
  lastMessageAt?: string;
  lastMessagePreview?: string;
  inboxKind?: "accepted" | "request";
  isMessageRequest?: boolean;
  conversationType?: string;
}

export interface BirdDmsResponse {
  success: true;
  conversations: BirdDmConversation[];
  events: BirdDmEvent[];
}

export interface XDmTransportPage {
  conversations: BirdDmConversation[];
  nextCursor: string;
  hasMore: boolean;
  collectedAt: Date;
  source: "bird-cli" | "x-web";
}

export interface XDmTransportRequest {
  cursor?: string;
  limit?: number;
  since?: Date;
  signal?: AbortSignal;
}

export interface XDmReadTransport {
  readonly name: "bird-cli" | "x-web" | "bird-with-web-fallback";
  checkConnection(
    signal?: AbortSignal,
  ): Promise<ConnectorHealth & { account?: XAccountIdentity }>;
  fetchPage(request: XDmTransportRequest): Promise<XDmTransportPage>;
}

export interface XWebEndpointConfig {
  accountSettingsUrl: string;
  inboxInitialStateUrl: string;
  conversationUrl(conversationId: string): string;
  bearerToken: string;
  dmParams: Readonly<Record<string, string>>;
}

export interface XSyncCursor {
  version: 1;
  transport: "bird-cli" | "x-web";
  complete: boolean;
  remainingConversationIds?: string[];
}
