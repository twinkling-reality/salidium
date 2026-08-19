import { appendFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';

export const DEFAULT_LOG_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LOG_FILES = 3;

export type LogLevel = 'silent' | 'info' | 'debug';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Keeps `file` plus a small numbered history (`.1` is newest). The launcher calls this before it
 * opens the descriptor inherited by a detached daemon, and the structured writer calls it while a
 * long-running daemon is alive.
 */
export function rotateLogFile(
  file: string,
  maxBytes = DEFAULT_LOG_MAX_BYTES,
  files = DEFAULT_LOG_FILES,
): boolean {
  if (maxBytes <= 0 || files < 1 || !existsSync(file)) return false;
  try {
    if (statSync(file).size < maxBytes) return false;
    const oldest = `${file}.${files}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = files - 1; index >= 1; index--) {
      const from = `${file}.${index}`;
      if (existsSync(from)) renameSync(from, `${file}.${index + 1}`);
    }
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Minimal structured logger. Never logs transcript content — only paths, counts, and errors.
 * Writes to stderr and optionally to a log file (for detached daemons).
 */
export function createLogger(level: LogLevel, file?: string): Logger {
  const write = (lvl: string, message: string, fields?: Record<string, unknown>) => {
    if (level === 'silent') return;
    if (lvl === 'debug' && level !== 'debug') return;
    const line = `${new Date().toISOString()} ${lvl.padEnd(5)} ${message}${fields ? ` ${JSON.stringify(fields)}` : ''}`;
    if (file) {
      try {
        rotateLogFile(file);
        appendFileSync(file, `${line}\n`, { mode: 0o600 });
      } catch {
        /* ignore */
      }
    } else {
      process.stderr.write(`${line}\n`);
    }
  };
  return {
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    debug: (m, f) => write('debug', m, f),
  };
}
