import { errorFields, logger, withLogContext, type LogFields, type Logger } from "@yesimbot/foundation";

/**
 * A conversation's logger (convention 07): every line carries the conversation, and its turn when the fields name one,
 * as log context instead of fields; a `cause` is written as `errorFields`, never as the error object itself.
 */
export function conversationLogger(scope: string, channel: string): Logger {
  const base = logger(scope);
  const emit =
    (level: keyof Logger) =>
    (event: string, fields: LogFields = {}): void => {
      const { turnId, cause, channel: _channel, ...rest } = fields;
      const record = cause === undefined ? rest : { ...rest, ...errorFields(cause) };
      withLogContext({ channel, ...(typeof turnId === "string" ? { turnId } : {}) }, () => base[level](event, record));
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
