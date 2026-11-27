/** Non-persisted state survives plugin/module reloads while its host service is still alive. */
export function scheduleHostState<T>(host: object, name: "mutations" | "triggers", create: () => T): T {
  const key = Symbol.for(`yesimbot.schedule.${name}`);
  if (!Object.hasOwn(host, key)) Object.defineProperty(host, key, { value: create() });
  return (host as Record<PropertyKey, T>)[key];
}
