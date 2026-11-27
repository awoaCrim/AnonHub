/// <reference types="vite/client" />
/// <reference types="novnc__novnc" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
