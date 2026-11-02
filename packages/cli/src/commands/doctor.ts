import { existsSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { join, resolve } from 'node:path';
import { formatBytes } from '@salidium/core';
import {
  createDiagnosticBundle,
  diagnosticManifest,
  inspectCodexHookTrust,
  readDaemonJson,
  readSettings,
} from '@salidium/daemon';
import { PROTOCOL_VERSION } from '@salidium/protocol';
import type { IntegrationContext, IntegrationValidation } from '../integrations.ts';
import { providerIntegrations, storeIntegrationLines, storeIntegrations } from '../integrations.ts';
import {
  collectionStatus,
  collectionStatusLabel,
  configuredHookPresent,
  essentialValidations,
  explanationStateLabel,
  hookTrustLabel,
  localExplanationState,
  observeProviders,
  presenceOf,
  queueLabel,
  readEffectiveOperationalConfig,
  readOperationsOverview,
  retentionLabel,
  salidiumHome,
  userHome,
  VERSION,
} from './shared.ts';

export async function doctorCommand(options: {
  json: boolean;
  quiet: boolean;
  bundle: boolean;
  dryRun: boolean;
  output?: string;
}): Promise<number> {
  const lines: string[] = [];
  let problems = 0;
  const validations = essentialValidations();
  for (const validation of validations) {
    lines.push(validation.message);
    if (validation.level === 'attention') problems++;
  }
  const d = readDaemonJson(salidiumHome);
  const presence = await presenceOf(d);
  lines.push(
    d && presence === 'reachable'
      ? `daemon running on ${d.port}`
      : d && presence === 'unresponsive'
        ? `daemon pid ${d.pid} is running on ${d.port} but did not answer; it may be importing history`
        : 'daemon not running',
  );
  let settingsProblem: string | undefined;
  readSettings(salidiumHome, (reason) => {
    settingsProblem = reason;
  });
  if (settingsProblem) {
    lines.push(
      'operational configuration is invalid; safe defaults are in force until it is repaired',
    );
    problems++;
  }
  lines.push(`explanations ${explanationStateLabel(localExplanationState())}`);
  const context: IntegrationContext = { userHome, salidiumHome };
  const providerResults: Array<{
    id: string;
    name: string;
    detected: boolean;
    validations: IntegrationValidation[];
    historyFound: boolean;
    hookStatus: string | null;
    hookTrust: string | null;
    hookTrustIssue: string | null;
  }> = [];
  for (const provider of providerIntegrations) {
    const detection = provider.detect(context);
    if (!detection.detected) {
      lines.push(`${provider.name} not detected`);
      providerResults.push({
        id: provider.id,
        name: provider.name,
        detected: false,
        validations: [],
        historyFound: false,
        hookStatus: null,
        hookTrust: null,
        hookTrustIssue: null,
      });
      continue;
    }
    if (!provider.liveHooksSupported(context)) {
      lines.push(
        `${provider.name} history-only on native Windows; live POSIX hooks are unavailable`,
      );
      lines.push(
        `${provider.name} history ${provider.historyDirectories(context).some(existsSync) ? 'found' : 'not found yet'}`,
      );
      providerResults.push({
        id: provider.id,
        name: provider.name,
        detected: true,
        validations: provider.validate(context),
        historyFound: provider.historyDirectories(context).some(existsSync),
        hookStatus: null,
        hookTrust: null,
        hookTrustIssue: null,
      });
      continue;
    }
    const inspection = provider.inspect(context);
    const providerValidations = provider.validate(context);
    for (const validation of providerValidations) {
      lines.push(validation.message);
      if (validation.level === 'attention') problems++;
    }
    const historyFound = provider.historyDirectories(context).some(existsSync);
    lines.push(`${provider.name} history ${historyFound ? 'found' : 'not found yet'}`);
    providerResults.push({
      id: provider.id,
      name: provider.name,
      detected: true,
      validations: providerValidations,
      historyFound,
      hookStatus: inspection.status,
      hookTrust: null,
      hookTrustIssue: null,
    });
  }
  const codexResult = providerResults.find((provider) => provider.id === 'codex');
  if (codexResult?.detected && codexResult.hookStatus !== 'not-configured') {
    const trust = await inspectCodexHookTrust(
      process.cwd(),
      process.env,
      3_000,
      undefined,
      VERSION,
    );
    codexResult.hookTrust = trust.trust;
    codexResult.hookTrustIssue = trust.issue ?? null;
    lines.push(`Codex hook trust ${hookTrustLabel(trust.trust).toLowerCase()}`);
    if (trust.trust === 'untrusted' || trust.trust === 'modified') problems++;
  }
  // Providers read from their own database have nothing to install; say whether each is found
  // and whether it is observed. A config that cannot be read leaves the shipped defaults.
  let enabledProviders: readonly string[] = ['claude-code', 'codex'];
  try {
    enabledProviders = (await readEffectiveOperationalConfig(d, presence)).values.providers.enabled
      .value;
  } catch {
    /* defaults */
  }
  lines.push(...storeIntegrationLines(context, enabledProviders));
  const storeResults = storeIntegrations.map((integration) => ({
    id: integration.id,
    name: integration.name,
    experimental: integration.experimental,
    detected: integration.detect(context),
    observed: enabledProviders.includes(integration.id),
  }));
  const collection = await collectionStatus(d, presence, configuredHookPresent());
  lines.push(`collection ${collectionStatusLabel(collection).toLowerCase()}`);
  lines.push(`queue ${queueLabel(collection)}`);
  lines.push(
    `store ${collection.store.bytes === null ? 'unavailable' : formatBytes(collection.store.bytes)}, retention ${retentionLabel(collection.store.retention).toLowerCase()}, last ingest ${collection.store.lastIngestAt ?? 'unavailable'}`,
  );
  if (collection.gaps.active.length > 0)
    lines.push(
      `collection has ${collection.gaps.active.length} active loss marker${collection.gaps.active.length === 1 ? '' : 's'}; exact dropped event counts are unavailable`,
    );
  if (collection.gaps.recovered.length > 0 || collection.gaps.omittedEpisodes > 0)
    lines.push(
      `collection ledger has ${collection.gaps.recovered.length} recovered episode${collection.gaps.recovered.length === 1 ? '' : 's'} and ${collection.gaps.omittedEpisodes} older omitted`,
    );
  if (collection.state === 'paused' && !collection.pause)
    lines.push('collection pause marker is unreadable; any later ordinary command will clear it');
  const exit =
    collection.health === 'runaway'
      ? 4
      : problems
        ? 1
        : collection.health === 'attention' || (collection.state === 'paused' && !collection.pause)
          ? 3
          : 0;
  let bundle:
    | { dryRun: true; manifest: ReturnType<typeof diagnosticManifest> }
    | { dryRun: false; result: ReturnType<typeof createDiagnosticBundle> }
    | undefined;
  if (options.bundle) {
    const now = new Date();
    const manifest = diagnosticManifest(now);
    if (options.dryRun) bundle = { dryRun: true, manifest };
    else {
      const providers = await observeProviders();
      const operations = await readOperationsOverview(d, presence, providers);
      const stamp = now
        .toISOString()
        .replaceAll(':', '')
        .replace(/\.\d{3}Z$/, 'Z');
      const outputPath = resolve(
        options.output ?? join(process.cwd(), `salidium-diagnostics-${stamp}.json`),
      );
      const result = createDiagnosticBundle({
        home: salidiumHome,
        outputPath,
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        storeSchemaVersion: operations.health.store.schemaVersion,
        config: operations.config,
        health: operations.health,
        alerts: operations.alerts,
        platform: {
          platform: platform(),
          release: release(),
          arch: arch(),
          node: process.versions.node,
        },
        now,
      });
      bundle = { dryRun: false, result };
    }
  }
  if (options.quiet) return exit;
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: exit === 0,
        exitCode: exit,
        daemon: d && presence !== 'absent' ? { ...d, token: undefined, presence } : { presence },
        validations,
        settingsProblem: settingsProblem ?? null,
        providers: providerResults,
        stores: storeResults,
        collection,
        diagnosticBundle: bundle ?? null,
      })}\n`,
    );
  } else {
    if (bundle?.dryRun)
      lines.push(
        `diagnostic bundle preview: ${bundle.manifest.entries.map((entry) => entry.name).join(', ')}; excludes ${bundle.manifest.excludes.join(', ')}`,
      );
    else if (bundle)
      lines.push(
        `diagnostic bundle written to ${bundle.result.path} (${formatBytes(bundle.result.bytes)}, ${bundle.result.redactions} redactions)`,
      );
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  return exit;
}
