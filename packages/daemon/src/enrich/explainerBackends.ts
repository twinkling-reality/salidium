import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveTrustedExecutable, trustedPathEntries } from '@salidium/adapter-kit';
import type { ProviderId } from '@salidium/protocol';

export type ExplainerMode = 'auto' | 'claude' | 'codex' | 'off';

export interface ExplainerBackendRequest {
  prompt: string;
  evidence: string;
  schema: unknown;
  model?: string;
  timeoutMs: number;
}

export interface ExplainerBackendResult {
  output: string;
  /** Human-readable generator label carried into explanation provenance. */
  model: string;
}

/** Built-in process output is rejected before it can grow memory or reach JSON parsing. */
export const MAX_EXPLAINER_OUTPUT_BYTES = 128 * 1024;

/**
 * A generator turns bounded evidence into the shared explanation schema. It does not ingest agent
 * records, read the repository, or decide what is verified. New model providers implement only
 * this interface; the event parser and visual language stay unchanged.
 */
export interface ExplainerBackend {
  id: string;
  isAvailable(environment?: NodeJS.ProcessEnv): boolean;
  generate(request: ExplainerBackendRequest): Promise<ExplainerBackendResult>;
}

interface ProcessInvocation {
  command: string;
  args: string[];
  input?: string;
  model: string;
}

function explainerCwd(): string {
  const dir = join(process.env.SALIDIUM_HOME ?? join(homedir(), '.salidium'), 'explainer');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function runProcess(invocation: ProcessInvocation, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const path = trustedPathEntries().join(delimiter);
    const child = spawn(invocation.command, invocation.args, {
      cwd: explainerCwd(),
      // Both Claude Code and Codex can fire their configured hooks. Never ingest this helper run.
      // A package runner prepends the current project's bins. The absolute provider command and
      // its child processes must see only the same trusted PATH used to detect the provider.
      env: { ...process.env, PATH: path, SALIDIUM_INTERNAL: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let outBytes = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`explainer timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (data) => {
      outBytes += Buffer.byteLength(data);
      if (outBytes > MAX_EXPLAINER_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        fail(new Error(`explainer output exceeded ${MAX_EXPLAINER_OUTPUT_BYTES} bytes`));
        return;
      }
      out += data;
    });
    child.stderr.on('data', (data) => {
      if (err.length < 8_192) err += String(data).slice(0, 8_192 - err.length);
    });
    child.on('error', (error) => {
      fail(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${invocation.command} exited ${code}: ${err.trim().slice(0, 200)}`));
    });
    child.stdin.end(invocation.input);
  });
}

export function buildClaudeInvocation(
  request: ExplainerBackendRequest,
  command = 'claude',
): ProcessInvocation {
  const model = request.model ?? 'claude-haiku-4-5-20251001';
  return {
    command,
    args: [
      '-p',
      // Remove project/user customization before any untrusted evidence reaches Claude.
      '--safe-mode',
      '--no-session-persistence',
      '--model',
      model,
      '--json-schema',
      JSON.stringify(request.schema),
      // Claude's print mode can otherwise use every built-in tool without an approval prompt.
      '--tools',
      '',
    ],
    input: `${request.prompt} ${request.evidence}`,
    model,
  };
}

export function buildCodexInvocation(
  request: ExplainerBackendRequest,
  schemaPath: string,
  command = 'codex',
): ProcessInvocation {
  const disabledFeatures = [
    'shell_tool',
    'unified_exec',
    'hooks',
    'apps',
    'plugins',
    'remote_plugin',
    'plugin_sharing',
    'multi_agent',
    'multi_agent_v2',
    'browser_use',
    'browser_use_external',
    'browser_use_full_cdp_access',
    'in_app_browser',
    'computer_use',
    'image_generation',
    'code_mode_host',
    'workspace_dependencies',
    'skill_search',
    'skill_mcp_dependency_install',
    'tool_call_mcp_elicitation',
    'tool_suggest',
    'auth_elicitation',
    'goals',
    'memories',
    'shell_snapshot',
  ] as const;
  const args = [
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    // Web search and image reads are tool settings rather than feature flags.
    '-c',
    'tools.web_search=false',
    '-c',
    'tools.view_image=false',
    '--output-schema',
    schemaPath,
  ];
  // Remove every current built-in capability that can read, transmit, delegate, customize or act
  // on evidence. Older Codex versions reject unknown flags and fail closed to the deterministic
  // report rather than silently running with a wider tool surface.
  for (const feature of disabledFeatures) args.push('--disable', feature);
  if (request.model) args.push('--model', request.model);
  args.push('-');
  return {
    command,
    args,
    input: `${request.prompt} ${request.evidence}`,
    model: request.model ?? 'Codex',
  };
}

function createClaudeExplainerBackend(resolvedCommand?: string): ExplainerBackend {
  return {
    id: 'claude',
    isAvailable: (environment) => resolveTrustedExecutable('claude', { environment }) !== undefined,
    async generate(request) {
      const command = resolvedCommand ?? resolveTrustedExecutable('claude');
      if (!command) throw new Error('trusted claude command is unavailable');
      const invocation = buildClaudeInvocation(request, command);
      return {
        output: await runProcess(invocation, request.timeoutMs),
        model: invocation.model,
      };
    },
  };
}

function createCodexExplainerBackend(resolvedCommand?: string): ExplainerBackend {
  return {
    id: 'codex',
    isAvailable: (environment) => resolveTrustedExecutable('codex', { environment }) !== undefined,
    async generate(request) {
      const command = resolvedCommand ?? resolveTrustedExecutable('codex');
      if (!command) throw new Error('trusted codex command is unavailable');
      const schemaPath = join(explainerCwd(), 'explanation-schema.json');
      writeFileSync(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
      const invocation = buildCodexInvocation(request, schemaPath, command);
      return {
        output: await runProcess(invocation, request.timeoutMs),
        model: invocation.model,
      };
    },
  };
}

export const claudeExplainerBackend = createClaudeExplainerBackend();
export const codexExplainerBackend = createCodexExplainerBackend();

const BUILT_IN_BACKEND_IDS = ['claude', 'codex'] as const;

function resolvedBuiltInBackends(environment: NodeJS.ProcessEnv): ExplainerBackend[] {
  const claude = resolveTrustedExecutable('claude', { environment });
  const codex = resolveTrustedExecutable('codex', { environment });
  return [
    ...(claude ? [createClaudeExplainerBackend(claude)] : []),
    ...(codex ? [createCodexExplainerBackend(codex)] : []),
  ];
}

export function configuredExplainerMode(environment = process.env): ExplainerMode | 'invalid' {
  // Preserve the original opt-out even after adding provider selection.
  if (environment.SALIDIUM_EXPLAIN === '0') return 'off';
  const value = (environment.SALIDIUM_EXPLAINER ?? 'auto').trim().toLowerCase();
  return value === 'auto' || value === 'claude' || value === 'codex' || value === 'off'
    ? value
    : 'invalid';
}

export function chooseExplainerBackendId(
  sourceProvider: ProviderId,
  mode: ExplainerMode | 'invalid',
  available: ReadonlySet<string>,
): string | undefined {
  if (mode === 'off' || mode === 'invalid') return undefined;
  if (mode !== 'auto') return available.has(mode) ? mode : undefined;

  const matching = sourceProvider === 'codex' ? 'codex' : 'claude';
  if (available.has(matching)) return matching;
  return BUILT_IN_BACKEND_IDS.find((id) => available.has(id));
}

export function resolveExplainerBackend(
  sourceProvider: ProviderId,
  environment = process.env,
): ExplainerBackend | undefined {
  const backends = resolvedBuiltInBackends(environment);
  const available = new Set(backends.map((backend) => backend.id));
  const id = chooseExplainerBackendId(
    sourceProvider,
    configuredExplainerMode(environment),
    available,
  );
  return backends.find((backend) => backend.id === id);
}

export interface ExplainerStatus {
  mode: ExplainerMode | 'invalid';
  available: string[];
  claudeCode: string | null;
  codex: string | null;
}

/** A side-effect-free diagnostic; executable presence does not imply that the CLI is authenticated. */
export function getExplainerStatus(environment = process.env): ExplainerStatus {
  const available = resolvedBuiltInBackends(environment).map((backend) => backend.id);
  const set = new Set(available);
  const mode = configuredExplainerMode(environment);
  return {
    mode,
    available,
    claudeCode: chooseExplainerBackendId('claude-code', mode, set) ?? null,
    codex: chooseExplainerBackendId('codex', mode, set) ?? null,
  };
}
