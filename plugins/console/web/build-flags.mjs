/** Compile-time flags for the standalone WebUI. Every component uses <script setup>, so the Options API is compiled out. */
export const vueFlags = {
  __VUE_OPTIONS_API__: "false",
  __VUE_PROD_DEVTOOLS__: "false",
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "false",
};
