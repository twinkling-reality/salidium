import type { ExplainerCadence } from '@salidium/protocol';
import { EXPLANATION_MODES, explanationMode } from './explanationMode.ts';
import type { InstallResult } from './hookInstaller.ts';
import type {
  IntegrationContext,
  IntegrationValidation,
  ProviderIntegration,
} from './integrations.ts';
import { providerIntegrations } from './integrations.ts';
import { homeRelative, type TerminalTone, TerminalUi } from './terminalUi.ts';

export interface OnboardingIO {
  interactive: boolean;
  color?: boolean;
  confirm(question: string): Promise<boolean>;
  select(question: string, options: readonly string[], selectedIndex: number): Promise<number>;
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
  explainerCadence?: ExplainerCadence;
  presented: boolean;
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
  const ui = new TerminalUi(io.color);
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
  const shouldDescribe = Boolean(options.firstRun || pending.length || invalid.length);

  if (shouldDescribe) {
    io.write(ui.header(Boolean(options.firstRun)));
    io.write(ui.section('Agents'));
    if (detected.length === 0) {
      io.write(ui.item('○', 'No supported coding agents detected', 'muted'));
      io.write(ui.close('→', 'Start Claude Code or Codex, then run Salidium again', 'accent'));
    } else {
      for (const provider of detected) {
        const inspection = inspections.get(provider.id);
        const detail =
          inspection?.status === 'configured'
            ? 'Connected'
            : provider.liveHooksSupported(context)
              ? 'Detected'
              : 'History only';
        io.write(
          ui.status(
            inspection?.status === 'configured' ? '✓' : '●',
            provider.name,
            detail,
            provider.id === 'claude-code' ? 'claude' : 'codex',
          ),
        );
      }
    }
    if (historyOnly.length > 0) {
      io.write(ui.spacer());
      io.write(
        ui.attention(
          `Native Windows imports ${names(historyOnly)} history; live POSIX hooks are unavailable`,
        ),
      );
    }
    for (const provider of invalid) {
      const inspection = inspections.get(provider.id);
      io.write(ui.spacer());
      io.write(
        ui.attention(
          `${provider.name} was not changed: ${inspection?.issue ?? 'its settings could not be read safely'}`,
        ),
      );
    }
  }

  let consent: OnboardingResult['consent'] = 'not-needed';
  let explainerCadence: ExplainerCadence | undefined;
  const changed: InstallResult[] = [];
  const guidance: string[] = [];
  if (pending.length > 0) {
    io.write(ui.section('Permission'));
    io.write(ui.copy('Salidium will add its hooks. Existing settings stay intact.'));
    io.write(ui.spacer());
    for (const [index, provider] of pending.entries()) {
      const settingsPath = inspections.get(provider.id)?.settingsPath;
      if (settingsPath)
        io.write(ui.path(provider.name, provider.id, homeRelative(settingsPath, context.userHome)));
      if (index < pending.length - 1) io.write(ui.spacer());
    }
    io.write(ui.spacer());

    let approved = Boolean(options.assumeYes);
    if (options.assumeYes) {
      consent = 'approved';
    } else if (io.interactive) {
      const question =
        pending.length === 1 ? `Connect ${pending[0]?.name}?` : 'Connect both agents?';
      approved = await io.confirm(question);
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
            ui.status('✓', provider.name, result.changed ? 'Connected' : 'Already connected', 'ok'),
          );
          guidance.push(...provider.guidance(result));
        } catch (error) {
          io.write(
            ui.failure(
              `${provider.name} could not be connected: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        }
      }
    } else if (consent === 'non-interactive') {
      io.write(
        ui.close(
          '○',
          'No changes made. Re-run with --yes, or use salidium install-hooks later.',
          'muted',
        ),
      );
    } else {
      io.write(ui.close('○', 'No changes made. Use salidium install-hooks when ready.', 'muted'));
    }
  }

  if (options.firstRun) {
    io.write(ui.section('Explanations'));
    io.write(ui.copy('Reports, evidence, and quantities stay local.'));
    io.write(ui.copy('Only the written Why and How can call a model.'));
    io.write(ui.spacer());
    let selectedIndex = 0;
    if (io.interactive && !options.assumeYes) {
      selectedIndex = await io.select(
        'Written Why + How',
        EXPLANATION_MODES.map((mode) => mode.label),
        0,
      );
    }
    explainerCadence = EXPLANATION_MODES[selectedIndex]?.value ?? 'off';
    const mode = explanationMode(explainerCadence);
    io.write(
      ui.close(
        explainerCadence === 'off' ? '✓' : '●',
        `${mode.label} · ${mode.detail}`,
        explainerCadence === 'off' ? 'ok' : 'accent',
      ),
    );
  }

  const validations = detected.flatMap((provider) => provider.validate(context));
  const attention = validations.filter((validation) => validation.level === 'attention');
  if (shouldDescribe || changed.length > 0) {
    const ready: Array<{ mark: string; text: string; tone: TerminalTone }> = [];
    if (detected.length === 0) {
      ready.push({ mark: '○', text: 'Waiting for Claude Code or Codex', tone: 'muted' });
    } else if (attention.length === 0) {
      ready.push({ mark: '✓', text: 'Setup checks passed', tone: 'ok' });
    } else {
      for (const validation of attention)
        ready.push({ mark: '!', text: validation.message, tone: 'warn' });
    }
    for (const instruction of guidance)
      ready.push({ mark: '!', text: `Codex: ${instruction}`, tone: 'warn' });

    io.write(ui.section('Ready'));
    for (const row of ready.slice(0, -1)) io.write(ui.item(row.mark, row.text, row.tone));
    const last = ready.at(-1);
    if (last) io.write(ui.close(last.mark, last.text, last.tone));
  }

  return {
    detected,
    changed,
    guidance,
    validations,
    consent,
    ...(explainerCadence ? { explainerCadence } : {}),
    presented: shouldDescribe || changed.length > 0,
  };
}
