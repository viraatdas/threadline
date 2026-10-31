import { Send } from "lucide-react";

export function BrandMark() {
  return (
    <div className="flex items-center gap-2.5" aria-label="Outbound home">
      <span className="grid size-8 place-items-center rounded-[8px] bg-ink text-white">
        <Send className="size-4" strokeWidth={2} aria-hidden="true" />
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold tracking-[-0.02em] text-ink">Outbound</span>
        <span className="block text-[11px] text-ink-faint">for Offstage</span>
      </span>
    </div>
  );
}
