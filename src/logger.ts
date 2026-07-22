import { createConsola } from "consola";

const LEVELS = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof LEVELS)[number];

function isLogLevel(value: string): value is LogLevel {
  return (LEVELS as readonly string[]).includes(value);
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "info"): LogLevel {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.toLowerCase();

  return isLogLevel(normalized) ? normalized : fallback;
}

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// Maps our log levels to consola's numeric verbosity thresholds.
// (consola: 0 = error, 1 = warn, 3 = info, 4 = debug)
const CONSOLA_LEVEL: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 3,
  debug: 4,
};

export function createLogger(level: LogLevel): Logger {
  return createConsola({ level: CONSOLA_LEVEL[level] });
}
