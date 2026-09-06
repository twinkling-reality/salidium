import { spawn } from 'node:child_process';
import { delimiter } from 'node:path';
import { resolveSystemExecutable, trustedPathEntries } from '@salidium/adapter-kit';
import type { LocalAlert } from '@salidium/protocol';
import type { AlertSink } from './alerts.ts';

export interface NativeNotificationInvocation {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}

type ExecutableResolver = (
  name: string,
  options: { environment: NodeJS.ProcessEnv; platform: NodeJS.Platform },
) => string | undefined;

export interface NativeNotificationOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  resolveExecutable?: ExecutableResolver;
  launch?: (invocation: NativeNotificationInvocation) => void;
  onError?: (error: unknown) => void;
}

/*
 * A recovery is written as a recovery, not as the alarm with a word in front of it.
 *
 * This used to return `Recovered: ${alert.title}` over the unchanged body, so the all-clear for a
 * queue backlog arrived as "Recovered: The durable queue is growing / Net growth crossed 100 files
 * in the sampled window. Open Salidium or run salidium status for details." Every sentence after
 * the first word described the problem in the present tense and then asked the reader to go
 * investigate a condition that was already over. `recoveryTitle` and `recoveryDetail` are optional
 * on the schema so a ledger written before they existed still parses; those alerts fall back to
 * the old text, which is why the prefix survives here rather than being deleted.
 */
function notificationText(alert: LocalAlert): { title: string; detail: string } {
  if (alert.state === 'recovered')
    return {
      title: alert.recoveryTitle ?? `Recovered: ${alert.title}`,
      detail: alert.recoveryDetail ?? alert.detail,
    };
  const detail =
    alert.kind === 'maintenance-failure'
      ? 'Maintenance needs local review. Open Salidium or run salidium maintenance status for details.'
      : alert.detail;
  return {
    title: alert.title,
    detail: `${detail} Open Salidium or run salidium status for details.`,
  };
}

/**
 * Resolves only a system-owned notifier and always passes alert text as data arguments. No shell
 * parses alert content, and the child inherits a sanitized executable path while retaining the OS
 * session variables needed to reach Notification Center, D-Bus, or the Windows desktop.
 */
export function resolveNativeNotification(
  alert: LocalAlert,
  options: Pick<NativeNotificationOptions, 'environment' | 'platform' | 'resolveExecutable'> = {},
): NativeNotificationInvocation | undefined {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const resolve = options.resolveExecutable ?? resolveSystemExecutable;
  const safePath = trustedPathEntries({ environment, platform }).join(
    platform === process.platform ? delimiter : platform === 'win32' ? ';' : ':',
  );
  const childEnvironment = { ...environment, PATH: safePath };
  const text = notificationText(alert);

  if (platform === 'darwin') {
    const command = resolve('osascript', { environment, platform });
    if (!command) return undefined;
    const script = [
      'on run argv',
      'display notification (item 2 of argv) with title "Salidium" subtitle (item 1 of argv)',
      'end run',
    ].join('\n');
    return {
      command,
      args: ['-e', script, text.title, text.detail],
      environment: childEnvironment,
    };
  }

  if (platform === 'win32') {
    const command =
      resolve('powershell.exe', { environment, platform }) ??
      resolve('powershell', { environment, platform });
    if (!command) return undefined;
    const title = Buffer.from(`Salidium: ${text.title}`, 'utf8').toString('base64');
    const detail = Buffer.from(text.detail, 'utf8').toString('base64');
    const script = [
      'param($Title64,$Body64)',
      '$title=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Title64))',
      '$body=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Body64))',
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$notice=New-Object System.Windows.Forms.NotifyIcon',
      '$notice.Icon=[System.Drawing.SystemIcons]::Information',
      '$notice.BalloonTipTitle=$title',
      '$notice.BalloonTipText=$body',
      '$notice.Visible=$true',
      '$notice.ShowBalloonTip(5000)',
      'Start-Sleep -Seconds 5',
      '$notice.Dispose()',
    ].join(';');
    return {
      command,
      args: ['-NoProfile', '-NonInteractive', '-Command', script, title, detail],
      environment: childEnvironment,
    };
  }

  const command = resolve('notify-send', { environment, platform });
  if (!command) return undefined;
  const urgency =
    alert.state === 'recovered' ? 'low' : alert.severity === 'critical' ? 'critical' : 'normal';
  return {
    command,
    args: [
      '--app-name=Salidium',
      `--urgency=${urgency}`,
      '--expire-time=10000',
      `Salidium · ${text.title}`,
      text.detail,
    ],
    environment: childEnvironment,
  };
}

function launchNativeNotification(
  invocation: NativeNotificationInvocation,
  onError: (error: unknown) => void,
): void {
  const child = spawn(invocation.command, invocation.args, {
    env: invocation.environment,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', onError);
  child.unref();
}

/** A best-effort local sink. Missing OS helpers and denied notification permission stay non-fatal. */
export class NativeAlertSink implements AlertSink {
  readonly #options: NativeNotificationOptions;

  constructor(options: NativeNotificationOptions = {}) {
    this.#options = options;
  }

  publish(alert: LocalAlert): void {
    const invocation = resolveNativeNotification(alert, this.#options);
    if (!invocation) return;
    const onError = this.#options.onError ?? (() => {});
    try {
      (this.#options.launch ?? ((value) => launchNativeNotification(value, onError)))(invocation);
    } catch (error) {
      onError(error);
    }
  }
}
