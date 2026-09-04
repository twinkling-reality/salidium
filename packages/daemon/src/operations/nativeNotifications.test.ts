import type { LocalAlert } from '@salidium/protocol';
import { describe, expect, it } from 'vitest';
import {
  NativeAlertSink,
  type NativeNotificationInvocation,
  resolveNativeNotification,
} from './nativeNotifications.ts';

function alert(overrides: Partial<LocalAlert> = {}): LocalAlert {
  return {
    id: 'alert-one',
    deduplicationKey: 'queue-age',
    kind: 'queue-age',
    severity: 'warning',
    state: 'active',
    title: 'Queued work is aging',
    detail: 'The oldest durable queue item is at least 10 minutes old.',
    firstSeenAt: '2026-09-04T12:00:00.000Z',
    lastSeenAt: '2026-09-04T12:00:00.000Z',
    lastTransitionAt: '2026-09-04T12:00:00.000Z',
    acknowledgedAt: null,
    recoveredAt: null,
    notificationEligible: true,
    ...overrides,
  };
}

const resolver = (name: string) => `/system/${name}`;

describe('native operational notifications', () => {
  it('passes macOS alert text as arguments instead of interpolating it into AppleScript', () => {
    const hostile = alert({
      title: 'Quote " and $(open bad)',
      detail: 'Body; do shell script "bad"',
    });
    const invocation = resolveNativeNotification(hostile, {
      platform: 'darwin',
      environment: {},
      resolveExecutable: resolver,
    });

    expect(invocation?.command).toBe('/system/osascript');
    expect(invocation?.args[1]).not.toContain(hostile.title);
    expect(invocation?.args).toContain(hostile.title);
    expect(invocation?.args.at(-1)).toContain(hostile.detail);
  });

  it('maps Linux severity and recovery without including private runtime paths', () => {
    const critical = resolveNativeNotification(alert({ severity: 'critical' }), {
      platform: 'linux',
      environment: { DISPLAY: ':1' },
      resolveExecutable: resolver,
    });
    expect(critical?.args).toContain('--urgency=critical');
    expect(critical?.environment.DISPLAY).toBe(':1');

    const recovered = resolveNativeNotification(alert({ state: 'recovered' }), {
      platform: 'linux',
      environment: {},
      resolveExecutable: resolver,
    });
    expect(recovered?.args).toContain('--urgency=low');
    expect(recovered?.args.join(' ')).toContain('Recovered: Queued work is aging');

    const maintenance = resolveNativeNotification(
      alert({
        kind: 'maintenance-failure',
        detail: 'failed at /Users/alice/private-project with token ghp_canary',
      }),
      { platform: 'linux', environment: {}, resolveExecutable: resolver },
    );
    expect(maintenance?.args.join(' ')).not.toContain('/Users/alice/private-project');
    expect(maintenance?.args.join(' ')).not.toContain('ghp_canary');
  });

  it('encodes Windows notification content before it crosses the PowerShell boundary', () => {
    const invocation = resolveNativeNotification(alert({ detail: "'quoted'; exit 9" }), {
      platform: 'win32',
      environment: {},
      resolveExecutable: resolver,
    });
    expect(invocation?.command).toBe('/system/powershell.exe');
    expect(invocation?.args.join(' ')).not.toContain("'quoted'; exit 9");
    expect(invocation?.args.at(-1)).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('is a best-effort no-op when the platform notifier is unavailable', () => {
    const launched: NativeNotificationInvocation[] = [];
    const sink = new NativeAlertSink({
      platform: 'linux',
      environment: {},
      resolveExecutable: () => undefined,
      launch: (invocation) => launched.push(invocation),
    });
    sink.publish(alert());
    expect(launched).toEqual([]);
  });

  it('launches one resolved native notification per transition', () => {
    const launched: NativeNotificationInvocation[] = [];
    const sink = new NativeAlertSink({
      platform: 'darwin',
      environment: {},
      resolveExecutable: resolver,
      launch: (invocation) => launched.push(invocation),
    });
    sink.publish(alert());
    expect(launched).toHaveLength(1);
    expect(launched[0]?.args).toContain('Queued work is aging');
  });
});
