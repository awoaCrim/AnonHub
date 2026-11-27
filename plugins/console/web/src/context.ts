import { inject, type InjectionKey } from "vue";

import type { LiveClient } from "./lib/live";
import type { Session } from "./lib/session";

export const sessionKey: InjectionKey<Session> = Symbol("session");
export const liveKey: InjectionKey<LiveClient> = Symbol("live");

export function useSession(): Session {
  const session = inject(sessionKey);
  if (!session) throw new Error("session not provided");
  return session;
}

export function useLive(): LiveClient {
  const live = inject(liveKey);
  if (!live) throw new Error("live client not provided");
  return live;
}
