import "./styles/app.css";
import { createApp } from "vue";

import App from "./App.vue";
import { liveKey, sessionKey } from "./context";
import { onUnauthorized } from "./lib/api";
import { createLiveClient } from "./lib/live";
import { createSession } from "./lib/session";
import { createAppRouter } from "./router";
import { initTheme } from "./theme";

initTheme();
const session = createSession(undefined, undefined, true);
const router = createAppRouter(session);

function toLogin() {
  const current = router.currentRoute.value;
  if (current.meta.public) return;
  session.invalidate();
  live.reset();
  // Use soft navigation when the session ends.
  void router.replace({ name: "login", query: current.fullPath === "/" ? {} : { returnTo: current.fullPath } });
}

const live = createLiveClient({
  // Last snapshots render instantly on reload; logs are large and only live.
  persist: (topic) => topic !== "logs",
  onSessionEnded: toLogin,
  onHardFailure: async () => {
    const authenticated = await session.refresh();
    if (!authenticated) toLogin();
    return authenticated;
  },
});
onUnauthorized(toLogin);
// A remembered session renders at once; the server's answer arrives in the background.
void session.verify()?.then((ok) => ok || toLogin());

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && session.state.authenticated) {
    void session.refresh().then((ok) => (ok ? live.reconnect() : toLogin()));
  }
});

createApp(App).provide(sessionKey, session).provide(liveKey, live).use(router).mount("#app");

// Registration is optional: unsupported/private browsers continue as the normal website.
if ("serviceWorker" in navigator && window.isSecureContext) {
  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
    },
    { once: true },
  );
}
