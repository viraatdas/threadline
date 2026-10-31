import { People } from "@/components/people";
import { loadCampaignOptions, loadPeople, sourceAvailability } from "@/lib/queries";
import { loadRuntimeState } from "@/lib/store";

export const metadata = { title: "People" };
export const maxDuration = 300;

export default async function PeoplePage({ searchParams }: { searchParams: Promise<{ q?: string; view?: string }> }) {
  const { q = "", view } = await searchParams;
  const [data, campaigns, sources, runtime] = await Promise.all([
    loadPeople({ view, q }),
    loadCampaignOptions(),
    sourceAvailability(),
    loadRuntimeState(),
  ]);
  return <People data={data} q={q} campaigns={campaigns} apollo={sources.apollo} lastFill={runtime.lastFill ?? null} />;
}
