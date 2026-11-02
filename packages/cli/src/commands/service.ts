import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { createInterface } from 'node:readline/promises';
import {
  daemonPaths,
  isOperationalConfigKey,
  OPERATIONAL_CONFIG_KEYS,
  readDaemonJson,
  readSettings,
  resetOperationalConfig,
  setOperationalConfigValue,
  writeSettings,
} from '@salidium/daemon';
import { type EffectiveOperationalConfig, ExplainerSettingsSchema } from '@salidium/protocol';
import { explanationMode, parseExplanationMode } from '../explanationMode.ts';
import type { IntegrationContext } from '../integrations.ts';
import { integrationById, providerIntegrations } from '../integrations.ts';
import {
  activateMacOSService,
  describeMacOSService,
  disableMacOSService,
  inspectMacOSService,
  prepareMacOSService,
  uninstallMacOSService,
} from '../macosService.ts';
import { runFirstRunOnboarding } from '../onboarding.ts';
import {
  consentKeyResult,
  selectionKeyResult,
  supportsTerminalColor,
  TerminalUi,
} from '../terminalUi.ts';
import {
  currentExplanationState,
  type ExplanationState,
  ensureDaemon,
  essentialValidations,
  explanationStateFromApi,
  explanationStateLabel,
  implicitlyResumeCollection,
  localExplanationState,
  openBrowser,
  presenceOf,
  readEffectiveOperationalConfig,
  salidiumHome,
  setCollectionState,
  stopDaemon,
  synchronizeOfflineRetention,
  uiUrl,
  userHome,
  VERSION,
  validateDaemonEnvironment,
} from './shared.ts';

function configPatch(key: string, value: unknown): Record<string, Record<string, unknown>> {
  const [group, field] = key.split('.');
  if (!group || !field) throw new Error(`invalid configuration key: ${key}`);
  return { [group]: { [field]: value } };
}

function parseConfigValue(key: string, raw: string): unknown {
  if (key === 'providers.enabled') {
    if (raw.trim() === 'none') return [];
    if (raw.trim().startsWith('[')) return JSON.parse(raw) as unknown;
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (key === 'git.enabled' || key === 'alerts.nativeNotifications') {
    if (raw !== 'true' && raw !== 'false') throw new Error(`${key} must be true or false`);
    return raw === 'true';
  }
  if (key === 'explainer.model') return raw === 'null' || raw === 'default' ? null : raw;
  if (
    key.endsWith('Minutes') ||
    key.endsWith('Seconds') ||
    key.endsWith('Bytes') ||
    key.endsWith('Files') ||
    key === 'history.days'
  ) {
    if (!/^\d+$/.test(raw)) throw new Error(`${key} must be a nonnegative whole number`);
    return Number(raw);
  }
  if (key === 'retention.days') return raw === 'forever' ? raw : Number(raw);
  return raw;
}

function effectiveRows(config: EffectiveOperationalConfig) {
  return [
    ['history.days', config.values.history.days],
    ['retention.days', config.values.retention.days],
    ['git.enabled', config.values.git.enabled],
    ['providers.enabled', config.values.providers.enabled],
    ['explainer.cadence', config.values.explainer.cadence],
    ['explainer.backend', config.values.explainer.backend],
    ['explainer.model', config.values.explainer.model],
    ['health.sampleIntervalSeconds', config.values.health.sampleIntervalSeconds],
    ['health.historyMinutes', config.values.health.historyMinutes],
    ['alerts.queueAgeMinutes', config.values.alerts.queueAgeMinutes],
    ['alerts.queueGrowthFiles', config.values.alerts.queueGrowthFiles],
    ['alerts.databaseSizeBytes', config.values.alerts.databaseSizeBytes],
    ['alerts.cooldownMinutes', config.values.alerts.cooldownMinutes],
    ['alerts.nativeNotifications', config.values.alerts.nativeNotifications],
    ['ui.operationsDetail', config.values.ui.operationsDetail],
  ] as const;
}

function renderEffectiveConfig(config: EffectiveOperationalConfig): void {
  process.stdout.write(
    `Configuration schema ${config.schemaVersion}, revision ${config.revision}\n`,
  );
  for (const [key, entry] of effectiveRows(config)) {
    const rendered = Array.isArray(entry.value)
      ? entry.value.join(',') || 'none'
      : entry.value === null
        ? 'default'
        : String(entry.value);
    const source =
      entry.source === 'environment' ? `environment (${entry.environment})` : entry.source;
    const restart = config.restartRequired.includes(key) ? '; restart required' : '';
    process.stdout.write(`${key.padEnd(30)} ${rendered}  [${source}${restart}]\n`);
  }
}

export async function runConfigCommand(
  arg: string | undefined,
  args: string[],
  options: { json: boolean; quiet: boolean },
): Promise<number> {
  const action = arg ?? 'show';
  const d = readDaemonJson(salidiumHome);
  const presence = await presenceOf(d);
  if (action === 'show') {
    const effective = await readEffectiveOperationalConfig(d, presence);
    if (!options.quiet) {
      if (options.json) process.stdout.write(`${JSON.stringify(effective)}\n`);
      else renderEffectiveConfig(effective);
    }
    return 0;
  }
  if (action !== 'set' && action !== 'reset') {
    process.stderr.write('config accepts show, set, or reset\n');
    return 2;
  }
  if (presence === 'unresponsive') {
    process.stderr.write(
      'the daemon is running but not answering; configuration was not changed\n',
    );
    return 1;
  }
  const key = args[0];
  if (action === 'set' && (!key || !isOperationalConfigKey(key) || args[1] === undefined)) {
    process.stderr.write(
      `usage: salidium config set KEY VALUE\nSupported keys: ${OPERATIONAL_CONFIG_KEYS.join(', ')}\n`,
    );
    return 2;
  }
  if (action === 'reset' && key && !isOperationalConfigKey(key)) {
    process.stderr.write(`unknown configuration key: ${key}\n`);
    return 2;
  }
  const configKey = key && isOperationalConfigKey(key) ? key : undefined;
  let effective: EffectiveOperationalConfig;
  try {
    const current =
      d && presence === 'reachable' ? await readEffectiveOperationalConfig(d, presence) : undefined;
    if (action === 'set') {
      const rawValue = args[1];
      if (!configKey || rawValue === undefined)
        throw new Error('configuration set request did not contain a supported key and value');
      const parsedValue = parseConfigValue(configKey, rawValue);
      if (d && presence === 'reachable' && current) {
        const response = await fetch(`http://127.0.0.1:${d.port}/api/operations/config`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${d.token}`,
            'Content-Type': 'application/json',
            'If-Match': String(current.revision),
          },
          body: JSON.stringify(configPatch(configKey, parsedValue)),
          signal: AbortSignal.timeout(2_000),
        });
        if (!response.ok) throw new Error(`daemon refused configuration (${response.status})`);
        effective = (await response.json()) as EffectiveOperationalConfig;
      } else {
        setOperationalConfigValue(salidiumHome, configKey, parsedValue);
        synchronizeOfflineRetention();
        effective = await readEffectiveOperationalConfig(d, presence);
      }
    } else if (d && presence === 'reachable' && current) {
      const query = key ? `?key=${encodeURIComponent(key)}` : '';
      const response = await fetch(`http://127.0.0.1:${d.port}/api/operations/config${query}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${d.token}`,
          'If-Match': String(current.revision),
        },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) throw new Error(`daemon refused configuration (${response.status})`);
      effective = (await response.json()) as EffectiveOperationalConfig;
    } else {
      resetOperationalConfig(salidiumHome, configKey);
      synchronizeOfflineRetention();
      effective = await readEffectiveOperationalConfig(d, presence);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (!options.quiet) {
    if (options.json) process.stdout.write(`${JSON.stringify(effective)}\n`);
    else {
      process.stdout.write('Configuration saved.\n');
      renderEffectiveConfig(effective);
    }
  }
  return effective.restartRequired.length > 0 ? 3 : 0;
}

export async function runExplanationsCommand(arg: string | undefined): Promise<number> {
  const d = readDaemonJson(salidiumHome);
  const presence = await presenceOf(d);
  if (!arg) {
    const state = await currentExplanationState(d, presence);
    const mode = explanationMode(state.effective);
    process.stdout.write(
      `Explanations: ${explanationStateLabel(state)}\n${state.writer ? `Written by: ${state.writer}\n` : ''}${mode.detail}. Reports, evidence, and quantities stay local.\nChange with: salidium explanations off|when-done|each-reply\n`,
    );
    return 0;
  }
  const cadence = parseExplanationMode(arg);
  if (!cadence) {
    process.stderr.write(
      'Choose off, when-done, or each-reply. Example: salidium explanations off\n',
    );
    return 2;
  }
  if (presence === 'unresponsive') {
    process.stderr.write(
      `daemon pid ${d?.pid ?? 'unknown'} is running but did not answer; the setting was not changed\n`,
    );
    return 1;
  }

  let state: ExplanationState;
  if (d && presence === 'reachable') {
    try {
      const response = await fetch(`http://127.0.0.1:${d.port}/api/settings/explainer`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${d.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cadence }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) {
        process.stderr.write(`daemon refused the explanation setting (${response.status})\n`);
        return 1;
      }
      const settings = ExplainerSettingsSchema.parse(await response.json());
      state = explanationStateFromApi(settings);
    } catch {
      process.stderr.write('daemon stopped answering; the explanation setting was not changed\n');
      return 1;
    }
  } else {
    writeSettings(salidiumHome, {
      ...readSettings(salidiumHome),
      explainerCadence: cadence,
    });
    state = localExplanationState();
  }
  const chosen = explanationMode(cadence);
  process.stdout.write(`Saved: ${chosen.label} · ${chosen.detail}\n`);
  if (state.effective !== cadence)
    process.stdout.write(
      'Local only is active because the daemon environment prevents model calls.\n',
    );
  return 0;
}

export async function runHooksCommand(
  cmd: 'install-hooks' | 'uninstall-hooks',
  arg: string | undefined,
): Promise<number> {
  const remove = cmd === 'uninstall-hooks';
  const context: IntegrationContext = { userHome, salidiumHome };
  const explicit = arg && arg !== 'all' ? integrationById(arg) : undefined;
  if (arg && arg !== 'all' && !explicit) {
    process.stderr.write(`unknown provider: ${arg}\n`);
    return 2;
  }
  let targets = explicit
    ? [explicit]
    : providerIntegrations.filter((provider) => provider.detect(context).detected);
  if (targets.length === 0) {
    process.stdout.write('no supported coding agents detected\n');
    return 1;
  }
  if (!remove) {
    const unavailable = targets.filter((provider) => !provider.liveHooksSupported(context));
    for (const provider of unavailable) {
      process.stdout.write(
        `${provider.name}: skipped. Native Windows uses transcript history only; POSIX live hooks were not installed\n`,
      );
    }
    targets = targets.filter((provider) => provider.liveHooksSupported(context));
    if (targets.length === 0) return 1;
  }
  for (const provider of targets) {
    const r = remove ? provider.remove(context) : provider.install(context);
    process.stdout.write(
      `${provider.name}: ${remove ? 'removed' : 'connected'}${r.changed ? '' : ' (no change)'} → ${r.settingsPath}\n`,
    );
    if (r.note) process.stdout.write(`  note: ${r.note}\n`);
    if (!remove) {
      for (const validation of provider.validate(context)) {
        if (validation.level === 'attention')
          process.stdout.write(`  needs attention: ${validation.message}\n`);
        // Someone who typed `install-hooks codex` is asking about the hooks, so the standing
        // caveat belongs in the answer whether or not this run changed a file.
        else if (validation.level === 'info')
          process.stdout.write(`  note: ${validation.message}\n`);
      }
    }
  }
  return 0;
}

export async function serviceCommand(
  action: string | undefined,
  options: { json: boolean; quiet: boolean },
): Promise<number> {
  const command = action ?? 'status';
  if (!['install', 'status', 'enable', 'disable', 'uninstall'].includes(command)) {
    process.stderr.write('service accepts install, status, enable, disable, or uninstall\n');
    return 2;
  }
  const serviceOptions = {
    home: salidiumHome,
    userHome,
    currentScript: process.argv[1] ?? '',
    version: VERSION,
  };
  if (command === 'status') {
    const state = inspectMacOSService(serviceOptions);
    if (!options.quiet) {
      if (options.json) process.stdout.write(`${JSON.stringify(state)}\n`);
      else process.stdout.write(`${describeMacOSService(state).join('\n')}\n`);
    }
    return state.installed && state.enabled && state.daemonLoaded && state.menuLoaded ? 0 : 1;
  }
  if (platform() !== 'darwin') {
    process.stderr.write('always-on mode is currently available on macOS only\n');
    return 2;
  }

  if (command === 'install') {
    validateDaemonEnvironment();
    prepareMacOSService(serviceOptions);
    const stopped = await stopDaemon();
    if (stopped && (!stopped.signaled || !stopped.exited)) {
      process.stderr.write(
        `the existing daemon (pid ${stopped.pid}) could not be stopped safely; the login service was prepared but not activated\n`,
      );
      return 1;
    }
    await implicitlyResumeCollection();
    const paths = activateMacOSService(serviceOptions);
    const running = await ensureDaemon();
    if (!options.quiet) {
      if (options.json)
        process.stdout.write(
          `${JSON.stringify({ installed: true, enabled: true, pid: running.pid, paths })}\n`,
        );
      else
        process.stdout.write(
          `Always-on mode installed. Salidium keeps running in the background (pid ${running.pid}); see it in the menu bar or with \`salidium status\`, and stop it any time with \`salidium stop\` or \`salidium service disable\`.\nData remains in ${salidiumHome}.\nDisable: salidium service disable\nRemove service files: salidium service uninstall\n`,
        );
    }
    return 0;
  }

  if (command === 'enable') {
    validateDaemonEnvironment();
    const before = inspectMacOSService(serviceOptions);
    if (!before.installed) {
      process.stderr.write('always-on mode is not installed; run `salidium service install`\n');
      return 1;
    }
    const stopped = await stopDaemon();
    if (stopped && (!stopped.signaled || !stopped.exited)) {
      process.stderr.write(
        `the existing daemon (pid ${stopped.pid}) could not be stopped safely; always-on mode was not enabled\n`,
      );
      return 1;
    }
    await implicitlyResumeCollection();
    activateMacOSService(serviceOptions);
    const running = await ensureDaemon();
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ installed: true, enabled: true, pid: running.pid })}\n`
          : `Always-on mode enabled. Salidium is running (pid ${running.pid}).\n`,
      );
    return 0;
  }

  const before = inspectMacOSService(serviceOptions);
  if (!before.installed) {
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ installed: false, enabled: false, removed: false })}\n`
          : 'Always-on mode is not installed.\n',
      );
    return 0;
  }
  await setCollectionState('pause', 'stop');
  const stopped = await stopDaemon();
  if (command === 'disable') {
    disableMacOSService(serviceOptions);
    if (!options.quiet)
      process.stdout.write(
        options.json
          ? `${JSON.stringify({ installed: true, enabled: false, daemonStopped: stopped?.exited ?? true })}\n`
          : `Always-on mode disabled. Salidium and its menu bar are stopped; reports and settings remain in ${salidiumHome}.\nEnable again: salidium service enable\n`,
      );
    return stopped && (!stopped.signaled || !stopped.exited) ? 1 : 0;
  }

  const paths = uninstallMacOSService(serviceOptions);
  if (!options.quiet)
    process.stdout.write(
      options.json
        ? `${JSON.stringify({ installed: false, removed: true, dataHome: salidiumHome })}\n`
        : `Always-on service files removed from ${paths.root}. Reports and settings were kept in ${salidiumHome}.\n`,
    );
  return stopped && (!stopped.signaled || !stopped.exited) ? 1 : 0;
}

async function confirmSetup(question: string, color: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await prompt.question(`${question} [y/N] `);
      return /^(y|yes)$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  }

  const ui = new TerminalUi(color);
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = Boolean(input.isRaw);
  let selected = false;

  const render = () => output.write(`\u001b[?25l\r\u001b[2K${ui.choice(question, selected)}`);

  return new Promise<boolean>((resolve, reject) => {
    const finish = (decision: boolean) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      render();
      output.write('\u001b[?25h\n');
      resolve(decision);
    };
    const onData = (data: Buffer | string) => {
      const result = consentKeyResult(String(data), selected);
      selected = result.selected;
      if (result.aborted) {
        input.off('data', onData);
        input.setRawMode(wasRaw);
        if (!wasRaw) input.pause();
        output.write('\u001b[?25h\n');
        reject(new Error('Aborted with Ctrl+C'));
        return;
      }
      if (result.decision !== undefined) {
        finish(result.decision);
        return;
      }
      render();
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    render();
  });
}

async function selectTerminalOption(
  question: string,
  options: readonly string[],
  initialIndex: number,
  color: boolean,
): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return initialIndex;

  const ui = new TerminalUi(color);
  const input = process.stdin;
  const output = process.stdout;
  const wasRaw = Boolean(input.isRaw);
  let selectedIndex = initialIndex;

  const render = () =>
    output.write(`\u001b[?25l\r\u001b[2K${ui.choices(question, options, selectedIndex)}`);

  return new Promise<number>((resolve, reject) => {
    const finish = (decision: number) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      if (!wasRaw) input.pause();
      selectedIndex = decision;
      render();
      output.write('\u001b[?25h\n');
      resolve(decision);
    };
    const onData = (data: Buffer | string) => {
      const result = selectionKeyResult(String(data), selectedIndex, options.length);
      selectedIndex = result.selectedIndex;
      if (result.aborted) {
        input.off('data', onData);
        input.setRawMode(wasRaw);
        if (!wasRaw) input.pause();
        output.write('\u001b[?25h\n');
        reject(new Error('Aborted with Ctrl+C'));
        return;
      }
      if (result.decision !== undefined) {
        finish(result.decision);
        return;
      }
      render();
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    render();
  });
}

export async function runUpCommand(options: {
  assumeYes: boolean;
  noOpen: boolean;
}): Promise<number> {
  const context: IntegrationContext = { userHome, salidiumHome };
  const color = supportsTerminalColor(Boolean(process.stdout.isTTY));
  const firstRun = !existsSync(daemonPaths(salidiumHome).db);
  const onboarding = await runFirstRunOnboarding(
    context,
    {
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      color,
      confirm: (question) => confirmSetup(question, color),
      select: (question, optionsList, selectedIndex) =>
        selectTerminalOption(question, optionsList, selectedIndex, color),
      write: (text) => process.stdout.write(text),
    },
    {
      assumeYes: options.assumeYes,
      firstRun,
    },
  );
  if (onboarding.explainerCadence) {
    writeSettings(salidiumHome, {
      ...readSettings(salidiumHome),
      explainerCadence: onboarding.explainerCadence,
    });
  }
  const systemAttention = essentialValidations().filter(
    (validation) => validation.level === 'attention',
  );
  if (systemAttention.length > 0 && onboarding.presented) {
    const ui = new TerminalUi(color);
    process.stdout.write(ui.section('System'));
    for (const validation of systemAttention.slice(0, -1))
      process.stdout.write(ui.item('!', validation.message, 'warn'));
    const last = systemAttention.at(-1);
    if (last) process.stdout.write(ui.close('!', last.message, 'warn'));
  } else {
    for (const validation of systemAttention)
      process.stdout.write(`Needs attention: ${validation.message}.\n`);
  }
  const running = await ensureDaemon();
  if (!options.noOpen && process.stdout.isTTY) openBrowser(uiUrl(running));
  const url = uiUrl(running);
  const ui = new TerminalUi(color);
  const state = await currentExplanationState(running, 'reachable');
  if (onboarding.presented) {
    process.stdout.write(
      ui.open(url, !options.noOpen && Boolean(process.stdout.isTTY), Boolean(firstRun)),
    );
  } else if (process.stdout.isTTY) {
    const mode = explanationMode(state.effective);
    process.stdout.write(ui.running(mode.label, mode.detail));
    process.stdout.write(ui.open(url, !options.noOpen));
  } else {
    process.stdout.write(`${url}\n`);
  }
  return 0;
}
