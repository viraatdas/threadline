import { Today } from "@/components/today";
import { loadToday } from "@/lib/queries";

export const maxDuration = 300;

export default async function TodayPage() {
  return <Today data={await loadToday()} />;
}
