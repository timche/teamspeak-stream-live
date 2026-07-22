import { createConsola, LogLevels, type LogType } from "consola";

const level = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();

export const logger = createConsola({
  level: level in LogLevels ? LogLevels[level as LogType] : LogLevels.info,
});
