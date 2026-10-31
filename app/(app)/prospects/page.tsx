import { Prospects } from "@/components/prospects";
import { loadCampaignOptions, loadProspects } from "@/lib/queries";

export const metadata = { title: "Prospects" };
export const maxDuration = 300;

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<{ q?: string; view?: string }> }) {
  const { q = "", view = "all" } = await searchParams;
  const [rows, campaigns] = await Promise.all([loadProspects({ q, view }), loadCampaignOptions()]);
  return <Prospects rows={rows} view={view} q={q} campaigns={campaigns} />;
}
