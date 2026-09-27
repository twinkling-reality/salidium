import {
  consumerCredentialPath,
  consumerDiscoveryPath,
  createConsumerCredential,
  listConsumerCredentials,
  revokeConsumerCredential,
} from '@salidium/daemon';

/*
 * `salidium consumer`: the person's control over which local tools may read Salidium's reports.
 *
 * Its own module rather than a branch of `main.ts`, which runs the CLI on import, so the command can
 * be exercised against a temporary home in tests. It edits the credential file directly and needs no
 * running daemon; a running daemon picks the change up on its next request.
 */

export const CONSUMER_HELP = `Usage:
  salidium consumer create LABEL   Create a read-only credential for one local tool
  salidium consumer list           Show credentials (labels and ids, never secrets)
  salidium consumer revoke ID      Revoke one credential; it stops working immediately

A consumer credential reads session reports through the local consumer contract and nothing else.
It cannot change settings, delete sessions, ingest hook events, or ask a model for an explanation.
The token is printed once, at creation. Salidium keeps only a digest of it.
`;

interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

export function runConsumerCommand(
  home: string,
  subcommand: string | undefined,
  args: readonly string[],
  options: { json: boolean },
  io: Output,
): number {
  if (subcommand === 'create') {
    const label = args.join(' ').trim();
    if (!label) {
      io.err('name the tool this credential is for: salidium consumer create LABEL\n');
      return 2;
    }
    let created: ReturnType<typeof createConsumerCredential>;
    try {
      created = createConsumerCredential(home, label);
    } catch (error) {
      io.err(`${messageOf(error)}\n`);
      return 1;
    }
    if (options.json) {
      io.out(
        `${JSON.stringify({ ...created, discovery: consumerDiscoveryPath(home) }, null, 2)}\n`,
      );
      return 0;
    }
    io.out(
      [
        `Created read-only consumer credential ${created.credential.id} for "${created.credential.label}".`,
        '',
        'Token, shown this once. Give it to the tool now; Salidium cannot show it again:',
        '',
        `  ${created.token}`,
        '',
        `The tool finds the daemon in ${consumerDiscoveryPath(home)} while Salidium runs.`,
        `Revoke it with: salidium consumer revoke ${created.credential.id}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (subcommand === 'list') {
    let credentials: ReturnType<typeof listConsumerCredentials>;
    try {
      credentials = listConsumerCredentials(home);
    } catch (error) {
      io.err(
        `${consumerCredentialPath(home)} could not be read (${messageOf(error)}). No consumer is authorized until it is repaired or removed.\n`,
      );
      return 1;
    }
    if (options.json) {
      io.out(`${JSON.stringify({ credentials }, null, 2)}\n`);
      return 0;
    }
    if (credentials.length === 0) {
      io.out('No consumer credentials. Create one with: salidium consumer create LABEL\n');
      return 0;
    }
    const idWidth = 12;
    io.out(
      `${'ID'.padEnd(idWidth)}  ${'CREATED'.padEnd(24)}  LABEL\n${credentials
        .map(
          (credential) =>
            `${credential.id.padEnd(idWidth)}  ${credential.createdAt.padEnd(24)}  ${credential.label}`,
        )
        .join('\n')}\n`,
    );
    return 0;
  }

  if (subcommand === 'revoke') {
    const id = args[0];
    if (!id || args.length > 1) {
      io.err('name one credential id: salidium consumer revoke ID\n');
      return 2;
    }
    let revoked: boolean;
    try {
      revoked = revokeConsumerCredential(home, id);
    } catch (error) {
      io.err(`${messageOf(error)}\n`);
      return 1;
    }
    if (!revoked) {
      io.err(`no consumer credential has id ${id}\n`);
      return 1;
    }
    io.out(
      options.json
        ? `${JSON.stringify({ revoked: id })}\n`
        : `Revoked ${id}. Requests with it are refused now, and an open feed closes within seconds.\n`,
    );
    return 0;
  }

  (subcommand === undefined || subcommand === 'help' ? io.out : io.err)(CONSUMER_HELP);
  return subcommand === undefined || subcommand === 'help' ? 0 : 2;
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: Array<{ message: string }> }).issues;
    if (issues[0]) return issues[0].message;
  }
  return error instanceof Error ? error.message : String(error);
}
