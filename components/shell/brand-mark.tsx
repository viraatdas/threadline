import { Network } from "lucide-react";

export function BrandMark() {
  return (
    <div className="flex items-center gap-2.5" aria-label="Threadline home">
      <span className="grid size-8 place-items-center rounded-[8px] bg-accent text-white shadow-[inset_0_0_0_1px_oklch(0_0_0/0.08)]">
        <Network className="size-4" strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.02em] text-ink">Threadline</span>
    </div>
  );
}
