import { createEntry } from "./entry.js";
import type { AgentEntry } from "./entry.js";
import type { AgentStorage } from "./storage.js";

export interface AgentCustomState {}

export interface AgentState extends AgentCustomState {
  version: number;
}

export interface AgentStateManager {
  get(): AgentState;
  set(next: AgentState): Promise<void> | void;
  update(updater: (current: AgentState) => AgentState): Promise<AgentState> | AgentState;
}

export function createStateManager(options: { storage: AgentStorage<AgentEntry>; initialState?: AgentState }): AgentStateManager {
  let current = options.initialState ?? { version: 1 };

  return {
    get() {
      return current;
    },
    async set(next) {
      current = next;
      await options.storage.append(createEntry("state", next));
    },
    async update(updater) {
      const next = updater(current);
      await this.set(next);
      return next;
    },
  };
}
