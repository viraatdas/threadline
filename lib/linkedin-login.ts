import { z } from "zod";

// What Settings relays to the worker's sign-in view: the owner's clicks, typing
// and a few editing keys. Shared by the page and the server action; the worker
// checks the same shapes again.
export const LINKEDIN_LOGIN_KEYS = ["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"] as const;

const coordinate = z.number().min(0).max(4000);

export const linkedinLoginInputSchema = z
  .array(
    z.union([
      z.object({ type: z.enum(["down", "up", "move"]), x: coordinate, y: coordinate }),
      z.object({ type: z.literal("scroll"), x: coordinate, y: coordinate, dy: z.number().min(-5000).max(5000) }),
      z.object({ type: z.literal("text"), text: z.string().min(1).max(1000) }),
      z.object({ type: z.literal("key"), key: z.enum(LINKEDIN_LOGIN_KEYS) }),
    ]),
  )
  .min(1)
  .max(200);

export type LinkedinLoginInput = z.infer<typeof linkedinLoginInputSchema>[number];
