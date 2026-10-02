import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CONSUMER_TOKEN_PATTERN } from '@salidium/consumer-contract';
import { z } from 'zod';
import { writePrivateJsonAtomic } from '../operations/files.ts';
import { withCredentialLock } from './credentialLock.ts';

/**
 * Read-only consumer credentials.
 *
 * A consumer credential is a bearer token the person creates on purpose, for one named tool, and can
 * revoke at any time. It opens the consumer contract under `/consumer/v1` and nothing else. The
 * owner token in `daemon.json` is untouched: it still changes every start, and a consumer
 * credential is not accepted anywhere the owner token is required, so it cannot write, delete,
 * configure, ingest hooks, or ask for an explanation.
 *
 * Only a SHA-256 of each secret is stored. The token is shown once, at creation, and cannot be
 * recovered afterwards; a lost token is revoked and replaced.
 *
 * The file, not the daemon, is the authority. The CLI edits it whether or not the daemon is
 * running, and the daemon re-reads it whenever its metadata changes, so creating a credential needs
 * no restart and revoking one takes effect on the next request.
 */
export const CONSUMER_CREDENTIALS_FILE = 'consumer-credentials.json';
const TOKEN_PREFIX = 'salidium_consumer_';

/** Enough for every tool a person could reasonably run, and a bound on what a mistake can create. */
export const MAX_CONSUMER_CREDENTIALS = 32;
export const CONSUMER_SCOPE = 'reports:read' as const;

const CredentialLabelSchema = z
  .string()
  .trim()
  .min(1, 'a credential needs a label naming the tool that will use it')
  .max(64, 'a credential label is at most 64 characters')
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127;
      }),
    'a credential label cannot contain control characters',
  );

const StoredCredentialSchema = z
  .object({
    id: z.string().regex(/^[0-9a-f]{12}$/),
    label: CredentialLabelSchema,
    createdAt: z.iso.datetime({ offset: false, precision: 3 }),
    scopes: z.tuple([z.literal(CONSUMER_SCOPE)]),
    secretSha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

const CredentialFileSchema = z
  .object({
    version: z.literal(1),
    credentials: z.array(StoredCredentialSchema).max(MAX_CONSUMER_CREDENTIALS),
  })
  .strict();
type CredentialFile = z.infer<typeof CredentialFileSchema>;

/** What may be shown about a credential. Never the secret or its digest. */
export interface ConsumerCredential {
  id: string;
  label: string;
  createdAt: string;
  scopes: [typeof CONSUMER_SCOPE];
}

export function consumerCredentialPath(home: string): string {
  return join(home, CONSUMER_CREDENTIALS_FILE);
}

function publicView(stored: z.infer<typeof StoredCredentialSchema>): ConsumerCredential {
  return {
    id: stored.id,
    label: stored.label,
    createdAt: stored.createdAt,
    scopes: [...stored.scopes],
  };
}

function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/**
 * Reads the credential file. Absent is an empty set. Unreadable or invalid throws: silently treating
 * a damaged file as empty would let the next `create` overwrite credentials a person still relies
 * on, and silently treating it as valid is not possible.
 */
function readCredentialFile(home: string): CredentialFile {
  const path = consumerCredentialPath(home);
  if (!existsSync(path)) return { version: 1, credentials: [] };
  return CredentialFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function listConsumerCredentials(home: string): ConsumerCredential[] {
  return readCredentialFile(home).credentials.map(publicView);
}

/** Creates a credential and returns the only copy of its token. */
export function createConsumerCredential(
  home: string,
  label: string,
  now: Date = new Date(),
): { credential: ConsumerCredential; token: string } {
  const parsedLabel = CredentialLabelSchema.parse(label);
  return withCredentialLock(home, () => {
    const file = readCredentialFile(home);
    if (file.credentials.length >= MAX_CONSUMER_CREDENTIALS)
      throw new Error(
        `at most ${MAX_CONSUMER_CREDENTIALS} consumer credentials may exist; revoke one first`,
      );
    let id: string;
    do id = randomBytes(6).toString('hex');
    while (file.credentials.some((credential) => credential.id === id));
    const secret = randomBytes(32).toString('hex');
    const stored = {
      id,
      label: parsedLabel,
      createdAt: now.toISOString(),
      scopes: [CONSUMER_SCOPE] as [typeof CONSUMER_SCOPE],
      secretSha256: digest(secret),
    };
    writePrivateJsonAtomic(consumerCredentialPath(home), {
      version: 1,
      credentials: [...file.credentials, stored],
    } satisfies CredentialFile);
    return { credential: publicView(stored), token: `${TOKEN_PREFIX}${id}_${secret}` };
  });
}

/** Removes a credential. Returns false when no credential has that id. */
export function revokeConsumerCredential(home: string, id: string): boolean {
  return withCredentialLock(home, () => {
    const file = readCredentialFile(home);
    const remaining = file.credentials.filter((credential) => credential.id !== id);
    if (remaining.length === file.credentials.length) return false;
    writePrivateJsonAtomic(consumerCredentialPath(home), {
      version: 1,
      credentials: remaining,
    } satisfies CredentialFile);
    return true;
  });
}

/**
 * The daemon's view of the credential file: re-read whenever its metadata changes, so the check on
 * each request is one `stat` rather than a parse.
 *
 * Fails closed. A file that cannot be parsed authorizes nothing until it is repaired, and the
 * problem is reported once through `onInvalid` rather than on every request.
 */
export class ConsumerCredentialVerifier {
  private signature: string | undefined;
  private credentials: z.infer<typeof StoredCredentialSchema>[] = [];
  private readonly home: string;
  private readonly onInvalid: ((reason: string) => void) | undefined;

  constructor(home: string, onInvalid?: (reason: string) => void) {
    this.home = home;
    this.onInvalid = onInvalid;
  }

  private refresh(): void {
    const path = consumerCredentialPath(this.home);
    let signature: string;
    try {
      const stat = statSync(path, { bigint: true });
      signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      signature = 'absent';
    }
    if (signature === this.signature) return;
    this.signature = signature;
    if (signature === 'absent') {
      this.credentials = [];
      return;
    }
    try {
      this.credentials = readCredentialFile(this.home).credentials;
    } catch (error) {
      this.credentials = [];
      this.onInvalid?.(`consumer credentials file is invalid; no consumer is authorized: ${error}`);
    }
  }

  /** The credential a presented token belongs to, or undefined. Constant time in the secret. */
  verify(token: string): ConsumerCredential | undefined {
    if (!CONSUMER_TOKEN_PATTERN.test(token)) return undefined;
    const id = token.slice(TOKEN_PREFIX.length, TOKEN_PREFIX.length + 12);
    const secret = token.slice(TOKEN_PREFIX.length + 13);
    this.refresh();
    const stored = this.credentials.find((credential) => credential.id === id);
    if (!stored) return undefined;
    const presented = Buffer.from(digest(secret), 'hex');
    const expected = Buffer.from(stored.secretSha256, 'hex');
    return timingSafeEqual(presented, expected) ? publicView(stored) : undefined;
  }

  /** Whether a credential verified earlier still exists, for long-lived feed connections. */
  stillValid(id: string): boolean {
    this.refresh();
    return this.credentials.some((credential) => credential.id === id);
  }
}
