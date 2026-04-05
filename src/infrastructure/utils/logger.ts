// src/infrastructure/utils/logger.ts
// Structured JSON logger compatible with Cloudflare Workers

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  service: string;
  message: string;
  [key: string]: unknown;
};

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getMinLevel(): LogLevel {
  // Read from env — Workers expose global env vars via bindings,
  // but for logger we default to "info" in production
  return (globalThis as unknown as { LOG_LEVEL?: string }).LOG_LEVEL as LogLevel ?? "info";
}

export function createLogger(service: string) {
  const minLevel = LOG_LEVELS[getMinLevel()];

  function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < minLevel) return;

    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      service,
      message,
      ...extra,
    };

    const output = JSON.stringify(entry);

    switch (level) {
      case "debug":
        console.debug(output);
        break;
      case "info":
        console.info(output);
        break;
      case "warn":
        console.warn(output);
        break;
      case "error":
        console.error(output);
        break;
    }
  }

  return {
    debug: (msg: string, extra?: Record<string, unknown>) => log("debug", msg, extra),
    info: (msg: string, extra?: Record<string, unknown>) => log("info", msg, extra),
    warn: (msg: string, extra?: Record<string, unknown>) => log("warn", msg, extra),
    error: (msg: string, extra?: Record<string, unknown>) => log("error", msg, extra),
  };
}
