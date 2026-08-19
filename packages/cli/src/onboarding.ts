import type { InstallResult } from './hookInstaller.ts';
import type {
  IntegrationContext,
  IntegrationValidation,
  ProviderIntegration,
} from './integrations.ts';
import { providerIntegrations } from './integrations.ts';

export interface OnboardingIO {
  interactive: boolean;
  confirm(question: string): Promise<boolean>;
  write(text: string): void;
}

export interface OnboardingOptions {
  assumeYes?: boolean;
  firstRun?: boolean;
  integrations?: readonly ProviderIntegration[];
}

export interface OnboardingResult {
  detected: ProviderIntegration[];
  changed: InstallResult[];
  guidance: string[];
  validations: IntegrationValidation[];
  consent: 'not-needed' | 'approved' | 'declined' | 'non-interactive';
}

function names(providers: readonly ProviderIntegration[]): string {
  return providers.map((provider) => provider.name).join(', ');
}

/**
 * Performs the provider-owned part of first run. It has no daemon or browser side effects, which
 * keeps consent testable and makes the bare command responsible for start/open only after setup.
 */
export async function runFirstRunOnboarding(
  context: IntegrationContext,
  io: OnboardingIO,
  options: OnboardingOptions = {},
): Promise<OnboardingResult> {
  const integrations = options.integrations ?? providerIntegrations;
  const detected = integrations.filter((provider) => provider.detect(context).detected);
  const hookCapable = detected.filter((provider) => provider.liveHooksSupported(context));
  const historyOnly = detected.filter((provider) => !provider.liveHooksSupported(context));
  const inspections = new Map(
    hookCapable.map((provider) => [provider.id, provider.inspect(context)] as const),
  );
  const invalid = hookCapable.filter(
    (provider) => inspections.get(provider.id)?.status === 'invalid',
  );
  const pending = hookCapable.filter((provider) => {
    const status = inspections.get(provider.id)?.status;
    return status === 'not-configured' || status === 'partial';
  });
  const configured = hookCapable.filter(
    (provider) => inspections.get(provider.id)?.status === 'configured',
  );
  const shouldDescribe = Boolean(options.firstRun || pending.length || invalid.length);

  if (shouldDescribe) {
    io.write(
      detected.length > 0
        ? `Detected: ${names(detected)}.\n`
        : 'Detected: no supported coding agents. Salidium will watch for Claude Code or Codex history when available.\n',
    );
    if (historyOnly.length > 0) {
      io.write(
        `History-only on native Windows: ${names(historyOnly)} transcripts are imported, but POSIX live hooks are not installed.\n`,
      );
    }
    if (configured.length > 0) io.write(`Already connected: ${names(configured)}.\n`);
    for (const provider of invalid) {
      const inspection = inspections.get(provider.id);
      io.write(
        `Needs attention: ${provider.name} configuration was not changed because ${inspection?.issue ?? 'it could not be read safely'}.\n`,
      );
    }
  }

  let consent: OnboardingResult['consent'] = 'not-needed';
  const changed: InstallResult[] = [];
  const guidance: string[] = [];
  if (pending.length > 0) {
    io.write('Permission requested: add Salidium hooks while preserving existing settings in:\n');
    for (const provider of pending) {
      io.write(`  ${provider.name}: ${inspections.get(provider.id)?.settingsPath}\n`);
    }

    let approved = Boolean(options.assumeYes);
    if (options.assumeYes) {
      consent = 'approved';
    } else if (io.interactive) {
      approved = await io.confirm(`Connect ${names(pending)}? [y/N] `);
      consent = approved ? 'approved' : 'declined';
    } else {
      consent = 'non-interactive';
    }

    if (approved) {
      for (const provider of pending) {
        try {
          const result = provider.install(context);
          changed.push(result);
          io.write(
            result.changed
              ? `Connected: ${provider.name}.\n`
              : `Connected: ${provider.name} (no changes needed).\n`,
          );
          guidance.push(...provider.guidance(result));
        } catch (error) {
          io.write(
            `Needs attention: ${provider.name} could not be connected: ${error instanceof Error ? error.message : String(error)}.\n`,
          );
        }
      }
    } else if (consent === 'non-interactive') {
      io.write(
        'No provider settings changed because this terminal is non-interactive. Re-run with --yes to approve setup, or use salidium install-hooks later.\n',
      );
    } else {
      io.write('No provider settings changed. Use salidium install-hooks when you are ready.\n');
    }
  }

  const validations = detected.flatMap((provider) => provider.validate(context));
  const attention = validations.filter((validation) => validation.level === 'attention');
  if (shouldDescribe || changed.length > 0) {
    if (attention.length === 0) io.write('Setup checks passed.\n');
    else for (const validation of attention) io.write(`Needs attention: ${validation.message}.\n`);
  }
  for (const instruction of guidance) io.write(`Codex requires one more action: ${instruction}\n`);

  return { detected, changed, guidance, validations, consent };
}
