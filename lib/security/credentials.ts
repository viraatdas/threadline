import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { z } from "zod";

import type { CredentialVault } from "@/lib/domain/contracts";
import { getEncryptionEnvironment } from "@/lib/security/env";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

const credentialEnvelopeSchema = z.object({
  version: z.literal(1),
  keyVersion: z.number().int().positive(),
  algorithm: z.literal(ALGORITHM),
  iv: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string().min(1),
});

export type CredentialEnvelope = z.infer<typeof credentialEnvelopeSchema>;

function decodeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");

  if (key.length !== 32) {
    throw new Error("INTEGRATION_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }

  return key;
}

function encodeEnvelope(envelope: CredentialEnvelope): string {
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

function decodeEnvelope(value: string): CredentialEnvelope {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return credentialEnvelopeSchema.parse(JSON.parse(decoded));
}

export function sealCredential(
  value: unknown,
  context: string,
  options?: { encodedKey?: string; keyVersion?: number },
): string {
  const environment = options?.encodedKey ? undefined : getEncryptionEnvironment();
  const key = decodeKey(options?.encodedKey ?? environment!.INTEGRATION_ENCRYPTION_KEY);
  const keyVersion = options?.keyVersion ?? environment!.INTEGRATION_ENCRYPTION_KEY_VERSION;
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));

  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return encodeEnvelope({
    version: 1,
    keyVersion,
    algorithm: ALGORITHM,
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

export function openCredential<T>(
  encodedEnvelope: string,
  context: string,
  options?: { encodedKey?: string; expectedKeyVersion?: number },
): T {
  const environment = options?.encodedKey ? undefined : getEncryptionEnvironment();
  const envelope = decodeEnvelope(encodedEnvelope);
  const expectedKeyVersion =
    options?.expectedKeyVersion ?? environment!.INTEGRATION_ENCRYPTION_KEY_VERSION;

  if (envelope.keyVersion !== expectedKeyVersion) {
    throw new Error(`Credential key version ${envelope.keyVersion} is not available.`);
  }

  const key = decodeKey(options?.encodedKey ?? environment!.INTEGRATION_ENCRYPTION_KEY);
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, "base64url"));
  const authTag = Buffer.from(envelope.authTag, "base64url");
  decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
    decipher.final(),
  ]);

  return JSON.parse(plaintext.toString("utf8")) as T;
}

export function credentialEnvelopesMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export class EnvironmentCredentialVault implements CredentialVault {
  async seal(value: unknown, context: string): Promise<string> {
    return sealCredential(value, context);
  }

  async open<T>(envelope: string, context: string): Promise<T> {
    return openCredential<T>(envelope, context);
  }
}
