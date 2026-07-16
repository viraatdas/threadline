"use client";

import { RotateCcw, X } from "lucide-react";

interface UndoNoticeProps {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export function UndoNotice({ message, onUndo, onDismiss }: UndoNoticeProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-4 bottom-24 z-30 flex max-w-[calc(100vw-32px)] items-center gap-3 rounded-lg border border-line bg-ink px-3 py-2.5 text-white shadow-[0_12px_40px_rgba(20,30,40,0.18)] lg:bottom-5"
    >
      <span className="text-[12px] leading-5">{message}</span>
      <button
        type="button"
        onClick={onUndo}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-[6px] px-2 text-[11px] font-semibold text-white transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <RotateCcw className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
        Undo
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="grid size-8 place-items-center rounded-[6px] text-white/70 hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        <X className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}
