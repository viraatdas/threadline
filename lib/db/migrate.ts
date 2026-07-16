import "dotenv/config";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { getDatabaseEnvironment } from "@/lib/security/env";

const { DATABASE_URL } = getDatabaseEnvironment();
const client = postgres(DATABASE_URL, { max: 1, prepare: false });

try {
  await migrate(drizzle(client), { migrationsFolder: "migrations" });
} finally {
  await client.end();
}
