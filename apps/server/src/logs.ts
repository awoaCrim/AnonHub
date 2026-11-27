import { configureLogging, observeLogs, type LogRecord } from "@yesimbot/foundation";

/** The host's log level, and the records whoever reads them live gets (the console's log page). */
export class LogFanout {
  private quiet = false;

  /** `level` is Koishi's scale, which `logLevel` uses: 0 nothing, 1 errors, 2 also info and warnings, 3 also debug. */
  public configure(level: number): void {
    const named = level >= 3 ? "debug" : level >= 2 ? "info" : "error";
    this.quiet = level <= 0;
    configureLogging(this.quiet ? { level: named, sink: () => {} } : { level: named });
  }

  public subscribe(listener: (record: LogRecord) => void): () => void {
    return observeLogs((record) => {
      if (!this.quiet) listener(record);
    });
  }
}
