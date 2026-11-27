import { systemClock } from "@yesimbot/foundation";

import type { AgentInternalEvent } from "./event.js";
import { createRandomId } from "./id.js";
import type { AgentMessage } from "./message.js";
import type { AgentState } from "./state.js";

/** Default time for callers that pass none; Core passes its own. */
const clock = systemClock();

export type AgentCustomEntryData<T extends keyof AgentCustomEntries = keyof AgentCustomEntries> = AgentCustomEntries[T];

export type AgentEntry<T extends keyof AgentCustomEntries = keyof AgentCustomEntries> = T extends keyof AgentCustomEntries
  ? { data: AgentCustomEntryData<T>; id: string; parentId?: string; timestamp: number; type: T }
  : never;

/** Opaque, atomic historical region commit. Core owns source validation and request rendering. */
export interface ContextRegionEntryData {
  version: 1;
  lineageId: string;
  sourceSession: string;
  sourceEntryIds: string[];
  /** Binds both the canonical source entries and their delivery-safe readable projection. */
  sourceFingerprint: string;
  sourceStartAt: number;
  sourceEndAt: number;
  tiers: { P1: string; P2: string; P3: string; P4: string };
  importance: number;
  promptVersion: string;
}

export interface AgentCustomEntries {
  "context-region": ContextRegionEntryData;
  event: AgentInternalEvent;
  message: AgentMessage;
  state: AgentState;
}

export interface CreateEntryOptions {
  id?: string;
  timestamp?: number;
  parentId?: string;
}

export function createEntry<T extends keyof AgentCustomEntries>(type: T, data: AgentCustomEntryData<T>, options: CreateEntryOptions = {}): AgentEntry<T> {
  return { id: options.id ?? createRandomId(), type, data, timestamp: options.timestamp ?? clock.now(), parentId: options.parentId } as AgentEntry<T>;
}

export function createMessageEntry(message: AgentMessage, options: CreateEntryOptions = {}): AgentEntry<"message"> {
  return createEntry("message", message, options);
}

export function createEventEntry(event: AgentInternalEvent, options: CreateEntryOptions = {}): AgentEntry<"event"> {
  return createEntry("event", event, options);
}
