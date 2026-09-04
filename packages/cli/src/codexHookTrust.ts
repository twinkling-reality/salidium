import { spawn } from 'node:child_process';
import { resolveTrustedExecutable } from '@salidium/adapter-kit';

export type CodexHookTrust = 'trusted' | 'untrusted' | 'modified' | 'managed' | 'unknown';

export interface CodexHookTrustInspection {
  trust: CodexHookTrust;
  hooks: number;
  issue?: string;
}

interface HookMetadata {
  command?: unknown;
  trustStatus?: unknown;
}

/**
 * Reads Codex's own resolved hook metadata. Trust is not inferred from config.toml because Codex
 * exposes the current definition hash and its comparison result through the versioned app protocol.
 */
export function inspectCodexHookTrust(
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = 3_000,
): Promise<CodexHookTrustInspection> {
  const executable = resolveTrustedExecutable('codex', { environment });
  if (!executable)
    return Promise.resolve({ trust: 'unknown', hooks: 0, issue: 'codex command is unavailable' });

  return new Promise((resolve) => {
    const child = spawn(executable, ['app-server', '--stdio'], {
      cwd,
      env: { ...environment, SALIDIUM_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffered = '';
    let settled = false;
    const finish = (result: CodexHookTrustInspection) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ trust: 'unknown', hooks: 0, issue: 'codex hook trust check timed out' }),
      timeoutMs,
    );
    timer.unref?.();
    child.on('error', (error) =>
      finish({
        trust: 'unknown',
        hooks: 0,
        issue: `codex hook trust check failed: ${error.message}`,
      }),
    );
    child.on('exit', () => {
      if (!settled)
        finish({ trust: 'unknown', hooks: 0, issue: 'codex hook trust check ended early' });
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line) as Record<string, unknown>;
          if (message.id !== 2) continue;
          finish(summarizeCodexHookTrustResponse(message));
        } catch {
          /* Logs and protocol messages share stdout in some builds; only JSON id 2 is ours. */
        }
      }
    });
    child.stdin.end(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'salidium', title: 'Salidium', version: '0.3.0' },
          capabilities: {},
        },
      })}\n${JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } })}\n`,
    );
  });
}

export function summarizeCodexHookTrustResponse(
  message: Record<string, unknown>,
): CodexHookTrustInspection {
  const result = message.result as { data?: Array<{ hooks?: HookMetadata[] }> } | undefined;
  const hooks = (result?.data ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .filter((hook) => typeof hook.command === 'string' && hook.command.includes('SALIDIUM_HOOK=1'));
  if (hooks.length === 0)
    return { trust: 'unknown', hooks: 0, issue: 'no Salidium hooks resolved' };
  const statuses = hooks.map((hook) => hook.trustStatus);
  if (statuses.includes('modified')) return { trust: 'modified', hooks: hooks.length };
  if (statuses.includes('untrusted')) return { trust: 'untrusted', hooks: hooks.length };
  if (statuses.every((status) => status === 'managed'))
    return { trust: 'managed', hooks: hooks.length };
  if (statuses.every((status) => status === 'trusted' || status === 'managed'))
    return { trust: 'trusted', hooks: hooks.length };
  return { trust: 'unknown', hooks: hooks.length, issue: 'Codex returned an unknown trust state' };
}
