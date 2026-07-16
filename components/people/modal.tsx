"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/20 backdrop-blur-[1px]" />
        <Dialog.Content className="fixed top-1/2 left-1/2 z-50 max-h-[min(760px,calc(100vh-32px))] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-line bg-background shadow-[0_18px_60px_rgba(20,30,40,0.16)] focus:outline-none">
          <div className="border-b border-line px-5 py-4 sm:px-6">
            <Dialog.Title className="pr-10 text-[17px] font-semibold tracking-[-0.02em] text-ink">
              {title}
            </Dialog.Title>
            {description ? (
              <Dialog.Description className="mt-1 pr-8 text-[13px] leading-5 text-ink-muted">
                {description}
              </Dialog.Description>
            ) : null}
            <Dialog.Close
              className="absolute top-3.5 right-3.5 grid size-9 place-items-center rounded-[7px] text-ink-muted transition-colors hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              aria-label="Close dialog"
            >
              <X className="size-4" strokeWidth={1.8} aria-hidden="true" />
            </Dialog.Close>
          </div>
          <div className="px-5 py-5 sm:px-6">{children}</div>
          {footer ? (
            <div className="flex justify-end gap-2 border-t border-line px-5 py-4 sm:px-6">
              {footer}
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export const controlClass =
  "h-9 w-full rounded-[7px] border border-line bg-background px-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-accent focus:ring-2 focus:ring-accent/15";

export const textAreaClass = `${controlClass} min-h-24 resize-y py-2`;

export const secondaryButtonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-[7px] border border-line bg-background px-3 text-[12px] font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

export const primaryButtonClass =
  "inline-flex min-h-9 items-center justify-center gap-2 rounded-[7px] bg-accent px-3.5 text-[12px] font-semibold text-white transition-colors hover:bg-accent-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
