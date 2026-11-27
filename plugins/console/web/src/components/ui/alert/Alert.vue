<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui";
import { Primitive } from "reka-ui";
import type { HTMLAttributes } from "vue";

import type { AlertVariants } from ".";
import { alertVariants } from ".";
import { cn } from "../../../lib/utils";

const props = withDefaults(defineProps<PrimitiveProps & { class?: HTMLAttributes["class"]; variant?: AlertVariants["variant"] }>(), { as: "div" });
</script>

<template>
  <!-- Only a failure is announced as it appears; a caller's own role wins. -->
  <Primitive
    data-slot="alert"
    :as="as"
    :as-child="asChild"
    :role="variant === 'destructive' ? 'alert' : undefined"
    :class="cn(alertVariants({ variant }), props.class)"
  >
    <slot />
  </Primitive>
</template>
