import { delimiter } from 'node:path';
import { resolveTrustedExecutable, trustedPathEntries } from '@salidium/adapter-kit';

export interface RuntimePlatformOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** Rejects bad ports before a detached child is created and its failure becomes asynchronous. */
export function validateSalidiumPort(raw: string | undefined): void {
  if (raw === undefined) return;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(
      `SALIDIUM_PORT must be an integer from 0 to 65535 (received ${JSON.stringify(raw)})`,
    );
  }
}

export interface BrowserLaunch {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

/**
 * Resolves the OS opener once to an absolute, non-project executable. The sanitized PATH is also
 * inherited by the opener because tools such as xdg-open dispatch to another desktop command.
 */
export function resolveBrowserLaunch(
  url: string,
  options: RuntimePlatformOptions = {},
): BrowserLaunch | undefined {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const name = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const command = resolveTrustedExecutable(name, { environment, platform });
  if (!command) return undefined;
  const args = platform === 'win32' ? ['/d', '/c', 'start', '', url] : [url];
  const safePath = trustedPathEntries({ environment, platform }).join(
    platform === process.platform ? delimiter : platform === 'win32' ? ';' : ':',
  );
  return {
    command,
    args,
    environment: { ...environment, PATH: safePath },
  };
}
