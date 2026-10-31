import { SettingsView } from "@/components/settings";
import { loadSettingsData } from "@/lib/queries";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ gmail?: string; reason?: string }> }) {
  const [data, notice] = await Promise.all([loadSettingsData(), searchParams]);
  return <SettingsView data={data} notice={notice} />;
}
