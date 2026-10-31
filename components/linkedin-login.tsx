"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { toast } from "sonner";

import {
  cancelLinkedinLoginAction,
  finishLinkedinLoginAction,
  linkedinLoginInputAction,
  openLinkedinLoginAction,
} from "@/app/(app)/actions";
import { Button } from "@/components/ui";
import { LINKEDIN_LOGIN_KEYS, type LinkedinLoginInput } from "@/lib/linkedin-login";

const KEYS: ReadonlySet<string> = new Set(LINKEDIN_LOGIN_KEYS);
const clampScroll = (dy: number) => Math.max(-5000, Math.min(5000, dy));

// A live view of the worker's browser so the owner signs in to LinkedIn there
// (sessions copied from another browser get revoked). Frames come from
// /api/linkedin/login/screen; clicks and keys go back through a server action,
// in order, batched while one is in flight.
export function LinkedinLogin({ signedIn, disabled }: { signedIn: boolean; disabled: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<"closed" | "opening" | "open" | "finishing">("closed");
  const [frame, setFrame] = useState<{ src: string; host: string } | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const queue = useRef<LinkedinLoginInput[]>([]);
  const sending = useRef(false);
  const refresh = useRef(() => {});

  useEffect(() => {
    if (phase !== "open") return;
    let stopped = false;
    let src = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake = () => {};
    refresh.current = () => {
      clearTimeout(timer);
      wake();
    };
    void (async () => {
      while (!stopped) {
        const response = await fetch("/api/linkedin/login/screen", { cache: "no-store" }).catch(() => null);
        if (stopped) break;
        if (response?.status === 409) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          toast.error(body?.error ?? "The sign-in view closed.");
          setPhase("closed");
          break;
        }
        if (response?.status === 200) {
          const blob = await response.blob();
          if (stopped) break;
          const previous = src;
          src = URL.createObjectURL(blob);
          setFrame({ src, host: response.headers.get("x-page-host") ?? "" });
          if (previous) URL.revokeObjectURL(previous);
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 600);
        });
      }
    })();
    return () => {
      stopped = true;
      refresh.current();
      if (src) URL.revokeObjectURL(src);
    };
  }, [phase]);

  const send = (event: LinkedinLoginInput) => {
    const last = queue.current.at(-1);
    if (event.type === "scroll" && last?.type === "scroll") last.dy = clampScroll(last.dy + event.dy);
    else queue.current.push(event);
    if (sending.current) return;
    sending.current = true;
    void (async () => {
      while (queue.current.length) {
        const result = await linkedinLoginInputAction(queue.current.splice(0, 200));
        if (!result.ok) {
          queue.current = [];
          toast.error(result.error);
        }
      }
      sending.current = false;
      refresh.current();
    })();
  };

  // Screen coordinates → the browser's viewport (the image is scaled to fit).
  const at = (event: PointerEvent<HTMLImageElement> | WheelEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const box = image.getBoundingClientRect();
    if (!image.naturalWidth || !box.width) return null;
    const scale = image.naturalWidth / box.width;
    return {
      x: Math.round(Math.min(Math.max(event.clientX - box.left, 0), box.width) * scale),
      y: Math.round(Math.min(Math.max(event.clientY - box.top, 0), box.height) * scale),
    };
  };

  const open = async () => {
    setPhase("opening");
    const result = await openLinkedinLoginAction();
    if (!result.ok) {
      toast.error(result.error);
      setPhase("closed");
      return;
    }
    setFrame(null);
    setPhase("open");
  };

  const finish = async () => {
    setPhase("finishing");
    const result = await finishLinkedinLoginAction();
    setPhase("closed");
    if (!result.ok) return void toast.error(result.error);
    toast.success("LinkedIn signed in on the worker");
    router.refresh();
  };

  const cancel = async () => {
    setPhase("closed");
    await cancelLinkedinLoginAction();
    router.refresh();
  };

  if (phase === "closed" || phase === "opening") {
    return (
      <Button size="sm" variant={signedIn ? "ghost" : "primary"} disabled={disabled || phase === "opening"} onClick={() => void open()}>
        {phase === "opening" ? "Opening LinkedIn…" : signedIn ? "Sign in again" : "Sign in to LinkedIn"}
      </Button>
    );
  }

  return (
    <div className="space-y-2">
      <div
        ref={surface}
        tabIndex={0}
        role="application"
        aria-label="LinkedIn in the worker’s browser. Click into the page, then type."
        className="overflow-hidden rounded-[7px] border border-line bg-surface-subtle outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onKeyDown={(event) => {
          // Cmd/Ctrl+V arrives as a paste event; other shortcuts stay with this page.
          if (phase !== "open" || event.metaKey || event.ctrlKey) return;
          if (event.key.length === 1) {
            event.preventDefault();
            send({ type: "text", text: event.key });
          } else if (KEYS.has(event.key)) {
            event.preventDefault();
            send({ type: "key", key: event.key as (typeof LINKEDIN_LOGIN_KEYS)[number] });
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text/plain").slice(0, 1000);
          if (phase !== "open" || !text) return;
          event.preventDefault();
          send({ type: "text", text });
        }}
      >
        {phase === "finishing" ? (
          <p className="grid aspect-[16/10] place-items-center text-[13px] text-ink-muted">Checking the new session…</p>
        ) : frame ? (
          // eslint-disable-next-line @next/next/no-img-element -- live blob: frames, not a static asset
          <img
            src={frame.src}
            alt="LinkedIn in the worker’s browser"
            draggable={false}
            className="block h-auto w-full cursor-default select-none"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              surface.current?.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = at(event);
              if (point) send({ type: "down", ...point });
            }}
            onPointerUp={(event) => {
              if (event.button !== 0) return;
              const point = at(event);
              if (point) send({ type: "up", ...point });
            }}
            onWheel={(event) => {
              const point = at(event);
              if (point) send({ type: "scroll", ...point, dy: clampScroll(event.deltaY) });
            }}
          />
        ) : (
          <p className="grid aspect-[16/10] place-items-center text-[13px] text-ink-muted">Opening LinkedIn…</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={phase === "finishing"} onClick={() => void finish()}>
          Done, I’m signed in
        </Button>
        <Button size="sm" variant="ghost" disabled={phase === "finishing"} onClick={() => void cancel()}>
          Cancel
        </Button>
        {frame?.host ? <span className="text-[12px] text-ink-muted">on {frame.host}</span> : null}
      </div>
    </div>
  );
}
