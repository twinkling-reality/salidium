import { isAbsolute, resolve } from 'node:path';
import {
  allowRepository,
  DaemonProjectMapService,
  GitReadError,
  listOptedInRepositories,
  locateObjectStore,
  mainRootOf,
  ProjectMapCache,
  projectMapRepositoriesPath,
  readHeadCommit,
  revokeRepository,
} from '@salidium/daemon';
import { type ProjectMap, printable } from '@salidium/project-map';

/*
 * `salidium map`: the person's control over which repositories Salidium may map, and a way to look
 * at a map. Its own module, like `salidium consumer`, so tests can drive it against a temporary
 * home. It edits the opt-in file directly and needs no running daemon; a running daemon reads the
 * change on its next request.
 */

export const MAP_HELP = `Usage:
  salidium map allow REPOSITORY    Let Salidium map this repository's committed tree (experimental)
  salidium map list                Show the repositories Salidium may map
  salidium map revoke REPOSITORY   Stop mapping a repository and delete its cached maps
  salidium map show REPOSITORY [COMMIT]
                                   Build or reuse the map at COMMIT (a full id; default HEAD) and
                                   print a summary; --json prints the whole map

A project map lists a repository's tracked files, its package and assembly manifests, and the
imports between its JavaScript and TypeScript files, read from committed Git objects only: never the
working tree, and never a model. It is built when asked, never in the background.

Tools you've given a consumer credential can read the committed structure of every repository
you allow here: file paths, sizes, imports and manifests, not file contents.
`;

interface Output {
  out: (text: string) => void;
  err: (text: string) => void;
}

export async function runMapCommand(
  home: string,
  subcommand: string | undefined,
  args: readonly string[],
  options: { json: boolean; cwd?: string },
  io: Output,
): Promise<number> {
  const cwd = options.cwd ?? process.cwd();

  if (subcommand === 'allow') {
    const target = oneArgument(args, 'salidium map allow REPOSITORY', io);
    if (target === undefined) return 2;
    const root = await mainRootOf(resolve(cwd, target));
    if (!root) {
      io.err(`${shown(target)} is not inside a Git repository Salidium can read\n`);
      return 1;
    }
    let gitDir: string;
    try {
      gitDir = (await locateObjectStore(root)).gitDir;
    } catch (error) {
      io.err(`${messageOf(error)}\n`);
      return 1;
    }
    let result: ReturnType<typeof allowRepository>;
    try {
      result = allowRepository(home, root, gitDir);
    } catch (error) {
      io.err(`${messageOf(error)}\n`);
      return 1;
    }
    if (options.json) {
      io.out(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    io.out(
      [
        result.added
          ? `Salidium may now map ${shown(root)}.`
          : `${shown(root)} was already allowed (since ${result.repository.allowedAt}).`,
        `Maps read its committed objects from ${shown(gitDir)}.`,
        "Tools you've given a consumer credential can read this repository's committed structure.",
        `Stop with: salidium map revoke ${quote(shown(root))}`,
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (subcommand === 'list') {
    let repositories: ReturnType<typeof listOptedInRepositories>;
    try {
      repositories = listOptedInRepositories(home);
    } catch (error) {
      io.err(
        `${projectMapRepositoriesPath(home)} could not be read (${messageOf(error)}). No repository is mapped until it is repaired or removed.\n`,
      );
      return 1;
    }
    if (options.json) {
      io.out(
        `${JSON.stringify({ repositories: repositories.map(({ root, allowedAt }) => ({ root, allowedAt })) }, null, 2)}\n`,
      );
      return 0;
    }
    if (repositories.length === 0) {
      io.out('No repository is allowed. Allow one with: salidium map allow REPOSITORY\n');
      return 0;
    }
    io.out(
      `${'ALLOWED'.padEnd(24)}  REPOSITORY\n${repositories
        .map((r) => `${r.allowedAt.padEnd(24)}  ${shown(r.root)}`)
        .join('\n')}\n`,
    );
    return 0;
  }

  if (subcommand === 'revoke') {
    const target = oneArgument(args, 'salidium map revoke REPOSITORY', io);
    if (target === undefined) return 2;
    let repositories: ReturnType<typeof listOptedInRepositories>;
    try {
      repositories = listOptedInRepositories(home);
    } catch (error) {
      io.err(`${messageOf(error)}\n`);
      return 1;
    }
    // A repository that no longer exists can still be revoked by the root `list` shows.
    const absolute = resolve(cwd, target);
    const root = repositories.some((r) => r.root === absolute)
      ? absolute
      : await mainRootOf(absolute);
    const record = repositories.find((r) => r.root === root);
    if (!root || !record || !revokeRepository(home, root)) {
      io.err(`${shown(target)} is not allowed; see salidium map list\n`);
      return 1;
    }
    new ProjectMapCache(home).forget(record);
    io.out(
      options.json
        ? `${JSON.stringify({ revoked: root })}\n`
        : `Salidium no longer maps ${shown(root)}. Requests for it are refused now, and its cached maps are deleted.\n`,
    );
    return 0;
  }

  if (subcommand === 'show') {
    const [target, commitArgument, ...rest] = args;
    if (!target || rest.length > 0) {
      io.err('usage: salidium map show REPOSITORY [COMMIT]\n');
      return 2;
    }
    const root = await mainRootOf(resolve(cwd, target));
    if (!root) {
      io.err(`${shown(target)} is not inside a Git repository Salidium can read\n`);
      return 1;
    }
    const maps = new DaemonProjectMapService({ home });
    // Checked first, so nothing under a repository that is not allowed is read, HEAD included.
    if (!maps.isOptedIn(root)) {
      io.err(
        `${shown(root)} is not allowed. Allow it first with: salidium map allow ${quote(shown(root))}\n`,
      );
      return 1;
    }
    let commit = commitArgument;
    if (commit === undefined || commit === 'HEAD') {
      try {
        // HEAD is read only from the git directory the opt-in was granted for, the same check the
        // service makes before reading objects: a `.git` repointed since then is not followed.
        const granted = listOptedInRepositories(home).find((r) => r.root === root);
        const { gitDir } = await locateObjectStore(root);
        if (!granted || gitDir !== granted.gitDir) {
          io.err(
            `${shown(root)} now resolves to a different git directory than when it was allowed; allow it again with: salidium map allow ${quote(shown(root))}\n`,
          );
          return 1;
        }
        commit = (await readHeadCommit(gitDir)) ?? undefined;
      } catch (error) {
        io.err(`${messageOf(error)}\n`);
        return 1;
      }
      if (!commit) {
        io.err('HEAD does not name a commit; give a full commit id\n');
        return 1;
      }
    }
    const result = await maps.getMap(root, commit);
    if (!result.ok) {
      io.err(`${result.refusal.message}\n`);
      return 1;
    }
    io.out(options.json ? `${JSON.stringify(result.map)}\n` : summary(result.map));
    return 0;
  }

  (subcommand === undefined || subcommand === 'help' ? io.out : io.err)(MAP_HELP);
  return subcommand === undefined || subcommand === 'help' ? 0 : 2;
}

/** A short, human summary of a map: what it covers, what it found, and what it does not claim. */
export function summary(map: ProjectMap): string {
  const { coverage } = map;
  const modules = map.nodes.filter((n) => n.kind === 'module').length;
  const packages = map.nodes.filter((n) => n.kind === 'external-package').length;
  const lines = [
    `Project map of ${map.repository.root} (experimental)`,
    `  commit ${map.repository.commit}, committed ${map.repository.commitTime}`,
    `  ${coverage.files} files, ${modules} modules, ${packages} external packages`,
    `  ${coverage.internalFileEdges} import edges between files, ${map.edges.length} edges in all`,
    `  ${coverage.unresolved.total} unresolved${
      coverage.unresolved.byReason.length
        ? ` (${coverage.unresolved.byReason
            .slice(0, 4)
            .map((r) => `${r.count} ${r.reason}`)
            .join(', ')})`
        : ''
    }`,
    coverage.complete
      ? '  complete within its bounds'
      : `  incomplete: ${[
          ...coverage.boundsReached.map((b) => `${b} bound reached`),
          ...coverage.omittedFiles.map((o) => `${o.count} files omitted (${o.reason})`),
          ...(coverage.languages.some((l) => l.notParsed.missing > 0) ? ['blobs missing'] : []),
        ].join(', ')}`,
    '',
    `  ${'LANGUAGE'.padEnd(16)} ${'FILES'.padStart(6)} ${'PARSED'.padStart(6)}  ANALYSIS`,
    ...coverage.languages
      .slice(0, 12)
      .map(
        (l) =>
          `  ${l.language.padEnd(16)} ${String(l.files).padStart(6)} ${String(l.parsed).padStart(6)}  ${l.analysis}`,
      ),
    '',
    'Not analyzed:',
    ...coverage.notAnalyzed.map((n) => `  ${n.subject}`),
    '',
  ];
  return lines.join('\n');
}

/** A path as it may be printed: control characters and bidirectional overrides become `?`. */
const shown = (path: string): string => printable(path);

function oneArgument(args: readonly string[], usage: string, io: Output): string | undefined {
  if (args.length !== 1 || !args[0]) {
    io.err(`usage: ${usage}\n`);
    return undefined;
  }
  return args[0];
}

function quote(path: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(path) && isAbsolute(path)
    ? path
    : `'${path.replaceAll("'", "'\\''")}'`;
}

function messageOf(error: unknown): string {
  if (error instanceof GitReadError) return error.message;
  if (error && typeof error === 'object' && 'issues' in error) {
    const issues = (error as { issues: Array<{ message: string }> }).issues;
    if (issues[0]) return issues[0].message;
  }
  return error instanceof Error ? error.message : String(error);
}
