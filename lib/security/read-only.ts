import type { ReadOnlyCapabilities } from "@/lib/domain/schemas";

export const READ_ONLY_CAPABILITIES = Object.freeze({
  read: true,
  draft: true,
  send: false,
  modify: false,
  delete: false,
  connect: false,
  post: false,
  reply: false,
}) satisfies ReadOnlyCapabilities;

export const EXTERNAL_ACTION_VALUES = [
  "read",
  "draft",
  "send",
  "modify",
  "delete",
  "connect",
  "post",
  "reply",
] as const;

export type ExternalAction = (typeof EXTERNAL_ACTION_VALUES)[number];

export function assertExternalActionAllowed(action: ExternalAction): void {
  if (!READ_ONLY_CAPABILITIES[action]) {
    throw new Error(`External action "${action}" is prohibited by the Threadline v1 safety boundary.`);
  }
}

export function assertReadOnlyCapabilities(capabilities: ReadOnlyCapabilities): void {
  const prohibited = EXTERNAL_ACTION_VALUES.filter(
    (action) => !READ_ONLY_CAPABILITIES[action] && capabilities[action],
  );

  if (!capabilities.read || prohibited.length > 0) {
    throw new Error(`Connector violates read-only capabilities: ${prohibited.join(", ") || "read"}.`);
  }
}
