import { Campaigns } from "@/components/campaigns";
import { loadCampaigns } from "@/lib/queries";

export const metadata = { title: "Campaigns" };

export default async function CampaignsPage() {
  return <Campaigns rows={await loadCampaigns()} />;
}
