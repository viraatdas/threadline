import type { ThreadlineDatabase } from "@/lib/db/client";
import { createContactRepository } from "@/lib/db/repositories/contacts";
import { createIngestionRepository } from "@/lib/db/repositories/ingestion";
import { createIntegrationRepository } from "@/lib/db/repositories/integrations";
import { createSyncRepository } from "@/lib/db/repositories/sync";

export function createRepositories(database: ThreadlineDatabase) {
  return {
    contacts: createContactRepository(database),
    ingestion: createIngestionRepository(database),
    integrations: createIntegrationRepository(database),
    sync: createSyncRepository(database),
  };
}

export type ThreadlineRepositories = ReturnType<typeof createRepositories>;

export { createContactRepository } from "@/lib/db/repositories/contacts";
export { createIngestionRepository } from "@/lib/db/repositories/ingestion";
export { createIntegrationRepository } from "@/lib/db/repositories/integrations";
export { createSyncRepository } from "@/lib/db/repositories/sync";
