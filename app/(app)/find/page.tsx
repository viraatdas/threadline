import { Find } from "@/components/find";
import { sourceAvailability } from "@/lib/queries";

export const metadata = { title: "Find" };
export const maxDuration = 300;

export default async function FindPage() {
  return <Find availability={await sourceAvailability()} />;
}
