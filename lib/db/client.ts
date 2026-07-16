import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "@/lib/db/schema";
import { getDatabaseEnvironment } from "@/lib/security/env";

function createConnection(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: {
      application_name: "threadline-web",
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 15_000,
    },
  });

  return {
    client,
    database: drizzle(client, { schema }),
  };
}

type Connection = ReturnType<typeof createConnection>;
export type ThreadlineDatabase = Connection["database"];

let connection: Connection | undefined;

export function getDatabase(): ThreadlineDatabase {
  connection ??= createConnection(getDatabaseEnvironment().DATABASE_URL);
  return connection.database;
}

export async function closeDatabase(): Promise<void> {
  if (!connection) return;
  await connection.client.end();
  connection = undefined;
}
