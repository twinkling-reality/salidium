import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTrustedExecutable } from '@salidium/adapter-kit';
import type { HookInspection, HookProviderId, InstallResult } from './hookInstaller.ts';
import { inspectHooks, installClaudeCodeHooks, installCodexHooks } from './hookInstaller.ts';

export interface IntegrationContext {
  userHome: string;
  salidiumHome: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable so native-Windows behavior is testable on every CI host. */
  platform?: NodeJS.Platform;
}

export interface IntegrationDetection {
  detected: boolean;
  commandFound: boolean;
  stateFound: boolean;
}

export interface IntegrationValidation {
  level: 'ok' | 'info' | 'attention';
  message: string;
}

export interface ProviderIntegration {
  id: HookProviderId;
  name: string;
  stateDirectory(context: IntegrationContext): string;
  historyDirectories(context: IntegrationContext): string[];
  liveHooksSupported(context: IntegrationContext): boolean;
  detect(context: IntegrationContext): IntegrationDetection;
  inspect(context: IntegrationContext): HookInspection;
  install(context: IntegrationContext): InstallResult;
  remove(context: IntegrationContext): InstallResult;
  validate(context: IntegrationContext): IntegrationValidation[];
  guidance(result: InstallResult): string[];
}

function environment(context: IntegrationContext): NodeJS.ProcessEnv {
  return context.env ?? process.env;
}

function platform(context: IntegrationContext): NodeJS.Platform {
  return context.platform ?? process.platform;
}

interface ProviderDefinition {
  id: HookProviderId;
  name: string;
  command: string;
  /*
   * Something true whenever this provider is connected, which Salidium cannot verify for itself.
   * It is reported every time rather than once, because the alternative is a one-shot line printed
   * at install time and recoverable from nowhere: `doctor` said "configured" while the hooks sat
   * untrusted and nothing fired.
   */
  standingNote?: string;
  stateDirectory(context: IntegrationContext): string;
  historyDirectories(context: IntegrationContext): string[];
  install(context: IntegrationContext, remove: boolean): InstallResult;
}

function createIntegration(definition: ProviderDefinition): ProviderIntegration {
  const inspect = (context: IntegrationContext) =>
    inspectHooks(definition.id, context.userHome, context.salidiumHome, environment(context));
  return {
    ...definition,
    liveHooksSupported(context) {
      return platform(context) !== 'win32';
    },
    detect(context) {
      const env = environment(context);
      const commandFound = Boolean(
        resolveTrustedExecutable(definition.command, {
          environment: env,
          platform: platform(context),
        }),
      );
      const stateFound = existsSync(definition.stateDirectory(context));
      return { detected: commandFound || stateFound, commandFound, stateFound };
    },
    inspect,
    install(context) {
      if (platform(context) === 'win32') {
        throw new Error(
          `${definition.name} live hooks require a POSIX shell; native Windows uses transcript history only`,
        );
      }
      return definition.install(context, false);
    },
    remove(context) {
      return definition.install(context, true);
    },
    validate(context) {
      if (platform(context) === 'win32') {
        return [
          {
            level: 'info',
            message: `${definition.name} is available in history-only mode on native Windows; live hooks are not installed`,
          },
        ];
      }
      const inspection = inspect(context);
      if (inspection.status === 'invalid') {
        return [
          {
            level: 'attention',
            message: `${definition.name} configuration needs repair: ${inspection.issue ?? inspection.settingsPath}`,
          },
        ];
      }
      if (inspection.status === 'configured') {
        const ok: IntegrationValidation = {
          level: 'ok',
          message: `${definition.name} connection is configured`,
        };
        return definition.standingNote
          ? [ok, { level: 'info', message: definition.standingNote }]
          : [ok];
      }
      if (inspection.status === 'partial') {
        return [
          {
            level: 'attention',
            message: inspection.issue
              ? `${definition.name} connection is incomplete: ${inspection.issue}`
              : `${definition.name} connection is incomplete (${inspection.missingEvents.length} hook events missing or outdated)`,
          },
        ];
      }
      return [{ level: 'attention', message: `${definition.name} is not connected` }];
    },
    guidance(result) {
      return result.note ? [result.note] : [];
    },
  };
}

const claudeCode = createIntegration({
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  stateDirectory(context) {
    return environment(context).CLAUDE_CONFIG_DIR ?? join(context.userHome, '.claude');
  },
  historyDirectories(context) {
    return [join(this.stateDirectory(context), 'projects')];
  },
  install(context, remove) {
    return installClaudeCodeHooks(
      context.userHome,
      context.salidiumHome,
      remove,
      environment(context),
      platform(context),
    );
  },
});

const codex = createIntegration({
  id: 'codex',
  name: 'Codex',
  command: 'codex',
  standingNote:
    'Codex honours a hook only once it has been trusted there: open /hooks in Codex. Salidium cannot tell whether that has been done',
  stateDirectory(context) {
    return environment(context).CODEX_HOME ?? join(context.userHome, '.codex');
  },
  historyDirectories(context) {
    const state = this.stateDirectory(context);
    return [join(state, 'sessions'), join(state, 'archived_sessions')];
  },
  install(context, remove) {
    return installCodexHooks(
      context.userHome,
      context.salidiumHome,
      remove,
      environment(context),
      platform(context),
    );
  },
});

/**
 * Setup-side companion to the daemon's adapter registry. Provider-specific configuration stays
 * here, while onboarding and recovery consume only this registry contract.
 */
export class ProviderIntegrationRegistry {
  private readonly integrations = new Map<HookProviderId, ProviderIntegration>();

  constructor(integrations: readonly ProviderIntegration[] = []) {
    for (const integration of integrations) this.register(integration);
  }

  register(integration: ProviderIntegration): void {
    if (this.integrations.has(integration.id)) {
      throw new Error(`provider integration ${integration.id} is already registered`);
    }
    this.integrations.set(integration.id, integration);
  }

  get(id: string): ProviderIntegration | undefined {
    return this.integrations.get(id as HookProviderId);
  }

  list(): readonly ProviderIntegration[] {
    return [...this.integrations.values()];
  }
}

export const providerIntegrationRegistry = new ProviderIntegrationRegistry([claudeCode, codex]);

/** Compatibility view consumed by commands that only need to iterate. */
export const providerIntegrations: readonly ProviderIntegration[] =
  providerIntegrationRegistry.list();

export function integrationById(id: string): ProviderIntegration | undefined {
  return providerIntegrationRegistry.get(id);
}
