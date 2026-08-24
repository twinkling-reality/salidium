import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type PersonalizationSettings,
  type PersonalizationSettingsRequest,
  PersonalizationSettingsSchema,
} from '@salidium/protocol';

export const EMPTY_PERSONALIZATION: PersonalizationSettings = {
  version: 2,
  enabled: false,
  revision: 'none',
  profile: { guidance: '' },
};

interface LegacyProfile {
  context: string;
  familiarExamples: string[];
  terminology: string;
  detail: 'plain' | 'balanced' | 'technical';
}

/** Preserve profiles written by the unreleased structured editor while retiring its UI model. */
function migrateLegacyPersonalization(value: unknown): PersonalizationSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const settings = value as Record<string, unknown>;
  if (
    Object.keys(settings).sort().join(',') !== 'enabled,profile,revision,version' ||
    settings.version !== 1 ||
    typeof settings.enabled !== 'boolean' ||
    typeof settings.revision !== 'string' ||
    settings.revision.length < 1 ||
    settings.revision.length > 80 ||
    !settings.profile ||
    typeof settings.profile !== 'object' ||
    Array.isArray(settings.profile)
  )
    return null;
  const profile = settings.profile as Record<string, unknown>;
  if (
    Object.keys(profile).sort().join(',') !== 'context,detail,familiarExamples,terminology' ||
    typeof profile.context !== 'string' ||
    profile.context.trim().length > 240 ||
    !Array.isArray(profile.familiarExamples) ||
    profile.familiarExamples.length > 5 ||
    !profile.familiarExamples.every((item) => typeof item === 'string') ||
    !profile.familiarExamples.every(
      (item) => item.trim().length >= 1 && item.trim().length <= 48,
    ) ||
    typeof profile.terminology !== 'string' ||
    profile.terminology.trim().length > 240 ||
    !['plain', 'balanced', 'technical'].includes(String(profile.detail))
  )
    return null;
  const legacy = profile as unknown as LegacyProfile;
  const guidance = [
    legacy.context.trim(),
    legacy.familiarExamples.length > 0
      ? `Use examples from ${legacy.familiarExamples.join(', ')}.`
      : '',
    legacy.terminology.trim(),
    legacy.detail === 'plain'
      ? 'Use plain language.'
      : legacy.detail === 'technical'
        ? 'Keep the explanation technical.'
        : settings.enabled
          ? 'Use a balanced level of technical detail.'
          : '',
  ]
    .filter(Boolean)
    .join(' ');
  const migrated = PersonalizationSettingsSchema.safeParse({
    version: 2,
    enabled: settings.enabled,
    revision: settings.enabled ? randomBytes(12).toString('hex') : settings.revision,
    profile: { guidance },
  });
  return migrated.success ? migrated.data : null;
}

export function personalizationPath(home: string): string {
  return join(home, 'personalization.json');
}

/** A missing or corrupt profile is absence, never permission to send stale personal context. */
export function readPersonalization(
  home: string,
  onInvalid?: (reason: string) => void,
): PersonalizationSettings {
  const path = personalizationPath(home);
  if (!existsSync(path)) return structuredClone(EMPTY_PERSONALIZATION);
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const parsed = PersonalizationSettingsSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const migrated = migrateLegacyPersonalization(raw);
    if (migrated) {
      try {
        writePersonalization(home, migrated);
        return migrated;
      } catch (err) {
        onInvalid?.(err instanceof Error ? err.message : String(err));
        return structuredClone(EMPTY_PERSONALIZATION);
      }
    }
    onInvalid?.(parsed.error.issues.map((issue) => issue.message).join('; '));
  } catch (err) {
    onInvalid?.(err instanceof Error ? err.message : String(err));
  }
  return structuredClone(EMPTY_PERSONALIZATION);
}

/** Build a fresh revision only after the request has passed the shared wire schema. */
export function nextPersonalization(
  request: PersonalizationSettingsRequest,
): PersonalizationSettings {
  return {
    version: 2,
    enabled: request.enabled,
    revision: randomBytes(12).toString('hex'),
    profile: request.profile,
  };
}

/** Profile lifecycle is independent from model settings, so it has its own atomic 0600 file. */
export function writePersonalization(home: string, settings: PersonalizationSettings): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = personalizationPath(home);
  const temporary = join(
    home,
    `.personalization-${process.pid}-${randomBytes(6).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {
      /* never hide the original write/replace error */
    }
    throw err;
  }
}

export function deletePersonalization(home: string): void {
  try {
    unlinkSync(personalizationPath(home));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
