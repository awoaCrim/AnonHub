import { ref } from "vue";

/**
 * Form pages (route meta `width: "form"`) keep a 960px reading column. A page in a mode that needs
 * the full width — the role editor with its section nav and preview — sets this while that mode lasts.
 */
export const widePage = ref(false);

/**
 * Every page's content stops at 1280px. 对话 with the screen beside it is three columns and sets this
 * to use the whole window instead, so the screen is not squeezed into what is left.
 */
export const fullPage = ref(false);
