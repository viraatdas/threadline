import { z } from "zod";

const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")).or(z.string().startsWith("postgresql://")),
});

const encryptionEnvironmentSchema = z.object({
  INTEGRATION_ENCRYPTION_KEY: z.string().min(1),
  INTEGRATION_ENCRYPTION_KEY_VERSION: z.coerce.number().int().positive().default(1),
});

const authEnvironmentSchema = z.object({
  OWNER_EMAIL: z.string().email(),
  AUTH_SECRET: z.string().min(16),
});

export function getDatabaseEnvironment() {
  return databaseEnvironmentSchema.parse(process.env);
}

export function getEncryptionEnvironment() {
  return encryptionEnvironmentSchema.parse(process.env);
}

export function getAuthEnvironment() {
  return authEnvironmentSchema.parse(process.env);
}
