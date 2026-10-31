import { notFound } from "next/navigation";
import { z } from "zod";

import { CampaignView } from "@/components/campaign";
import { loadCampaign, loadCampaignOptions, sourceAvailability } from "@/lib/queries";

export const maxDuration = 300;

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const [data, campaigns, sources] = await Promise.all([loadCampaign(id), loadCampaignOptions(), sourceAvailability()]);
  if (!data) notFound();
  return <CampaignView data={data} campaigns={campaigns} apollo={sources.apollo} />;
}
