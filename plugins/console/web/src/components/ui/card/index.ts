import { cva } from "class-variance-authority";
export const cardVariants = cva("bg-card text-card-foreground flex flex-col gap-6 rounded-2xl border py-6");

export { default as Card } from "./Card.vue";

export { default as CardAction } from "./CardAction.vue";

export { default as CardContent } from "./CardContent.vue";

export { default as CardDescription } from "./CardDescription.vue";

export { default as CardFooter } from "./CardFooter.vue";

export { default as CardHeader } from "./CardHeader.vue";

export { default as CardTitle } from "./CardTitle.vue";
