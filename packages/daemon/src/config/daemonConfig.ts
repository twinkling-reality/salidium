import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderId } from '@salidium/protocol';

export interface DaemonConfig {
  /** Salidium's own state directory (default ~/.salidium). */
  home: string;
  /** User home used to locate provider state (default os.homedir()). */
  userHome: string;
  /** Loopback port. Fixed by default so hook relays can find the daemon without a lookup. */
  port: number;
  /** Backfill window for transcripts discovered on disk at startup. */
  historyDays: number;
  /** Run read-only git snapshots at turn boundaries. */
  gitEnrichment: boolean;
  /** Absolute path of the built UI (index.html + assets); undefined disables static hosting. */
  uiDist?: string;
  /** Provider ids to enable. */
  providers: ProviderId[];
  logLevel: 'silent' | 'info' | 'debug';
}

export const DEFAULT_PORT = 47822;
export const DEFAULT_HISTORY_DAYS = 7;

/**
 * Parses the transcript backfill window from the environment.
 *
 * The value is deliberately a whole number of days: partial days make the cutoff depend on the
 * daemon's start time in a way the CLI cannot explain, while negative and non-finite values silently
 * exclude every transcript. Zero remains useful for disabling startup backfill in CI and locally.
 */
export function validateSalidiumHistoryDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_HISTORY_DAYS;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `SALIDIUM_HISTORY_DAYS must be a nonnegative whole number (received ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

function validateHistoryDaysOverride(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('historyDays must be a nonnegative whole number');
  }
  return value;
}

export function resolveDaemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const userHome = overrides.userHome ?? homedir();
  const home = overrides.home ?? process.env.SALIDIUM_HOME ?? join(userHome, '.salidium');
  return {
    home,
    userHome,
    port: overrides.port ?? Number(process.env.SALIDIUM_PORT ?? DEFAULT_PORT),
    historyDays:
      overrides.historyDays === undefined
        ? validateSalidiumHistoryDays(process.env.SALIDIUM_HISTORY_DAYS)
        : validateHistoryDaysOverride(overrides.historyDays),
    gitEnrichment: overrides.gitEnrichment ?? process.env.SALIDIUM_NO_GIT !== '1',
    uiDist: overrides.uiDist,
    providers: overrides.providers ?? ['claude-code', 'codex'],
    logLevel:
      overrides.logLevel ?? ((process.env.SALIDIUM_LOG as DaemonConfig['logLevel']) || 'info'),
  };
}

export function daemonPaths(home: string) {
  return {
    home,
    db: join(home, 'salidium.db'),
    daemonJson: join(home, 'daemon.json'),
    spoolDir: join(home, 'spool'),
    hooksDir: join(home, 'hooks'),
    logFile: join(home, 'daemon.log'),
    /** Small launcher/uncaught-process stream, separate from the structured rotating daemon log. */
    startupLogFile: join(home, 'daemon-startup.log'),
  };
}
