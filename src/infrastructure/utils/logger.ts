// src/infrastructure/utils/logger.ts

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0, info: 1, warn: 2, error: 3,
};

function getMinLevel(): LogLevel {
  return (
    (globalThis as unknown as { LOG_LEVEL?: string }).LOG_LEVEL as LogLevel
  ) ?? "info";
}

export function createLogger(service: string) {
  const minLevel = LOG_LEVELS[getMinLevel()];

  function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < minLevel) return;
    const entry = {
      ts: new Date().toISOString(),
      level, service, message, ...extra,
    };
    const out = JSON.stringify(entry);
    switch (level) {
      case "debug": console.debug(out); break;
      case "info":  console.info(out);  break;
      case "warn":  console.warn(out);  break;
      case "error": console.error(out); break;
    }
  }

  return {
    debug: (msg: string, extra?: Record<string, unknown>) => log("debug", msg, extra),
    info:  (msg: string, extra?: Record<string, unknown>) => log("info",  msg, extra),
    warn:  (msg: string, extra?: Record<string, unknown>) => log("warn",  msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log("error", msg, extra),
  };
}
