import { notFound } from "next/navigation";
import { z } from "zod";

import { CompanyView } from "@/components/company";
import { loadCampaignOptions, loadCompany, sourceAvailability } from "@/lib/queries";

export const maxDuration = 300;

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const [data, campaigns, availability] = await Promise.all([loadCompany(id), loadCampaignOptions(), sourceAvailability()]);
  if (!data) notFound();
  return <CompanyView data={data} campaigns={campaigns} apollo={availability.apollo} />;
}
