import type { LogFormat, LogLevel } from "../config/types.ts";
import { redactFields } from "./redact.ts";

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly format: LogFormat;
  // --dump-raw reserves stdout for the dump itself, so every line goes to
  // stderr for that entry point.
  readonly allLogsToStderr?: boolean;
  readonly write?: (stream: "stdout" | "stderr", line: string) => void;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 };

function formatLine(
  format: LogFormat,
  level: LogLevel,
  message: string,
  fields: Record<string, unknown> | undefined,
): string {
  const time = new Date().toISOString();
  const safe = fields === undefined ? {} : (redactFields(fields) as Record<string, unknown>);
  if (format === "json") return JSON.stringify({ ...safe, time, level, message });
  const suffix = Object.keys(safe).length === 0 ? "" : ` ${JSON.stringify(safe)}`;
  return `${time} [${level}] ${message}${suffix}`;
}

const defaultWrite = (stream: "stdout" | "stderr", line: string): void => {
  (stream === "stdout" ? process.stdout : process.stderr).write(line);
};

// warn and error go to stderr, debug and info to stdout.
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const write = options.write ?? defaultWrite;

  function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < threshold) return;
    const stream =
      options.allLogsToStderr === true || level === "warn" || level === "error"
        ? "stderr"
        : "stdout";
    write(stream, `${formatLine(options.format, level, message, fields)}\n`);
  }

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}
