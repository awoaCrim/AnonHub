import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

export { default as Alert } from "./Alert.vue";
export { default as AlertDescription } from "./AlertDescription.vue";
export { default as AlertTitle } from "./AlertTitle.vue";

/**
 * A notice inside a page. Unlike upstream shadcn it lays its children out in a row (an icon, a sentence,
 * a button), so plain text and inline actions need no AlertTitle/AlertDescription wrappers.
 */
export const alertVariants = cva(
  "relative flex w-full flex-wrap items-start gap-x-3 gap-y-1 rounded-xl border border-transparent px-4 py-3 text-sm leading-[1.55] [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:translate-y-0.5 [&>svg]:text-current",
  {
    variants: {
      variant: {
        // Soft fills, no outline: a notice reads as part of the page, not a box inside it (2026-11-20).
        default: "bg-muted/70 text-muted-foreground",
        destructive: "bg-danger-soft text-danger",
        warn: "bg-warn-soft text-warn",
        ok: "bg-ok-soft text-ok",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);
export type AlertVariants = VariantProps<typeof alertVariants>;
