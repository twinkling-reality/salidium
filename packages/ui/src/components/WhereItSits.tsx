import type {
  ExecutionLinks,
  FileLink,
  ModuleLink,
  Neighbour,
  RepositoryLink,
} from '@salidium/project-map';
import { shortHome } from '../lib/format.ts';

/*
 * The body of the Where it sits panel; `WhereItSitsPanel` fetches the document and opens it.
 * Kept free of the store so it renders the same for a test as for the daemon.
 */

const SHORT = 7;

/** A path as one shell word, so the command can be pasted as shown. */
export function shellWord(path: string): string {
  return /^[A-Za-z0-9_./~+-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

const CHOSEN: Record<NonNullable<RepositoryLink['commit']>['chosen'], string> = {
  'latest-turn-end': 'as of the latest turn end',
  'session-start': 'as of session start; no usable turn-end commit was seen',
};

/** Statuses of files that did not link, in plain words. */
const FILE_WORDS: Record<
  Exclude<FileLink['status'], 'linked' | 'repository-not-mapped'>,
  string
> = {
  'not-in-map':
    'Not in the map at that commit: added after it, or never committed. Nothing is matched by name instead.',
  'outside-repository': 'In no Git repository when Salidium saw the change.',
  'repository-unknown':
    'Salidium did not record which repository held these, as for sessions imported from history. It does not guess one.',
};

const UNAVAILABLE: Record<NonNullable<RepositoryLink['unavailable']>, string> = {
  'over-bound': 'This repository is larger than the experimental map reads.',
  busy: 'Another map was being built. Try again in a moment.',
  'repository-unsupported':
    'Salidium cannot read this repository safely, for example because it borrows objects from another directory.',
};

function repositoryWords(repository: RepositoryLink): string {
  switch (repository.status) {
    case 'mapped':
      return '';
    case 'not-opted-in':
      return 'Salidium has not been allowed to read this repository, so it has not.';
    case 'no-revision':
      return 'Salidium never saw which commit this repository was at during the session, so it does not pick one.';
    case 'revision-gone':
      return 'The commits Salidium saw during the session no longer exist in this repository: rewritten or removed.';
    case 'map-unavailable':
      return repository.unavailable ? UNAVAILABLE[repository.unavailable] : '';
  }
}

/** The panel's body, without fetching, so it renders the same for a test as for the daemon. */
export function WhereItSits({
  links,
  widened,
  onWiden,
  onRetry,
}: {
  links: ExecutionLinks;
  widened: boolean;
  onWiden: () => void;
  onRetry?: () => void;
}) {
  const mapped = links.repositories.filter((r) => r.status === 'mapped');
  const unmapped = links.repositories.filter((r) => r.status !== 'mapped');
  const linked = links.files.filter((f) => f.status === 'linked');
  const unlinked = (status: keyof typeof FILE_WORDS) =>
    links.files.filter((f) => f.status === status);

  if (links.files.length === 0)
    return (
      <div className="where-empty">
        <p className="rp-none">This session changed no files, so there is nothing to place.</p>
      </div>
    );

  const anyDependents = links.modules.some((m) => m.dependentsTotal > 0);
  return (
    <div className="where">
      {mapped.map((repository) => (
        <MappedRepository
          key={repository.root}
          repository={repository}
          modules={links.modules.filter((m) => m.repository === repository.root)}
          files={linked.filter((f) => f.repository === repository.root)}
          widened={widened}
        />
      ))}

      {links.modules.length > 0 && (
        <div className="where-widen">
          <button
            type="button"
            className={`btn ${widened ? 'is-on' : ''}`}
            aria-pressed={widened}
            onClick={onWiden}
            disabled={!anyDependents}
            title={
              anyDependents
                ? 'Show the modules that declare a dependency on the ones these files are in'
                : 'No module in this repository declares a dependency on these modules'
            }
          >
            {widened ? 'Hide what depends on these modules' : 'Show what depends on these modules'}
          </button>
          {!anyDependents && (
            <span className="rp-caveat">Nothing in the map depends on these modules.</span>
          )}
        </div>
      )}

      {unmapped.map((repository) => (
        <UnmappedRepository
          key={repository.root}
          repository={repository}
          files={links.files.filter(
            (f) => f.status === 'repository-not-mapped' && f.repository === repository.root,
          )}
          onRetry={onRetry}
        />
      ))}

      {(['not-in-map', 'outside-repository', 'repository-unknown'] as const).map((status) => {
        const files = unlinked(status);
        if (files.length === 0) return null;
        return (
          <section key={status} className="where-unlinked" aria-label={FILE_WORDS[status]}>
            <p className="where-why">{FILE_WORDS[status]}</p>
            <ul className="where-plain">
              {files.map((f) => (
                <li key={f.path} className="mono" title={f.path}>
                  <bdi>{f.relativePath ?? shortHome(f.path)}</bdi>
                </li>
              ))}
            </ul>
          </section>
        );
      })}

      {(links.filesTotal > links.files.length || links.filesOmitted > 0) && (
        <p className="viz-foot">
          {links.filesTotal - links.files.length > links.filesOmitted
            ? `${links.filesTotal - links.files.length - links.filesOmitted} older changed files not placed. `
            : ''}
          {links.filesOmitted > 0
            ? `${links.filesOmitted} changed ${links.filesOmitted === 1 ? 'path' : 'paths'} not shown: this view carries a path whole or not at all.`
            : ''}
        </p>
      )}

      <footer className="where-foot">
        {mapped.length > 0
          ? 'Observed in the committed tree at the commit named above, never the working tree. Test roles are inferred from file names. Experimental.'
          : 'No repository was mapped for this session, so nothing here is placed. Experimental.'}
      </footer>
    </div>
  );
}

function MappedRepository({
  repository,
  modules,
  files,
  widened,
}: {
  repository: RepositoryLink;
  modules: ModuleLink[];
  files: FileLink[];
  widened: boolean;
}) {
  const commit = repository.commit;
  const inModule = new Set(modules.flatMap((m) => m.changedFiles));
  const loose = files.filter((f) => f.relativePath !== null && !inModule.has(f.relativePath));
  const byPath = new Map<string, FileLink>();
  for (const f of files) if (f.relativePath) byPath.set(f.relativePath, f);
  return (
    <section className="where-repo" aria-label={`Repository ${repository.root}`}>
      <p className="where-at">
        <bdi className="mono" title={repository.root}>
          {shortHome(repository.root)}
        </bdi>
        {commit && (
          <>
            {' at '}
            <span className="mono" title={commit.id}>
              {commit.id.slice(0, SHORT)}
            </span>{' '}
            <span className="where-quiet">{CHOSEN[commit.chosen]}</span>{' '}
            <span className="rp-derived" title="Salidium read this commit while the session ran">
              observed
            </span>
          </>
        )}
      </p>
      {repository.mapComplete === false && (
        <p className="rp-caveat">
          The map stopped at a size bound, so a missing link here means unknown, not none.
        </p>
      )}
      {modules.map((module) => (
        <section key={module.module.id} className="where-module">
          <h3 className="where-module-head">
            <span className="where-module-name">
              {module.module.name ?? module.module.manifest}
            </span>
            <span className="mono where-quiet" title="The manifest that declares this module">
              {module.module.manifest}
            </span>
          </h3>
          <ul className="where-files">
            {module.changedFiles.map((path) => {
              const file = byPath.get(path);
              return file ? <ChangedFileRow key={path} file={file} /> : null;
            })}
          </ul>
          {widened && <Dependents module={module} />}
        </section>
      ))}
      {loose.length > 0 && (
        <section className="where-module">
          <h3 className="where-module-head">
            <span className="where-module-name">In no module</span>
            <span className="where-quiet">no manifest governs these files</span>
          </h3>
          <ul className="where-files">
            {loose.map((file) => (
              <ChangedFileRow key={file.path} file={file} />
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

function Dependents({ module }: { module: ModuleLink }) {
  if (module.dependentsTotal === 0)
    return <p className="where-ring2 rp-none">No module in the map depends on this one.</p>;
  return (
    <div className="where-ring2">
      <p className="where-label">Depended on by</p>
      <ul className="where-plain">
        {module.dependents.map((d) => (
          <li key={d.edge}>
            <span>{d.module.name ?? d.module.manifest}</span>{' '}
            <span className="mono where-quiet">{d.module.manifest}</span>{' '}
            <span className="where-rule">{d.rule}</span>
          </li>
        ))}
      </ul>
      {module.dependentsTruncated && (
        <p className="viz-foot">
          {module.dependentsTotal - module.dependents.length} more not shown
        </p>
      )}
    </div>
  );
}

const KIND_WORDS: Partial<Record<Neighbour['kind'], string>> = {
  'imports-type': 'types only',
  're-exports': 're-exports',
  'imports-dynamic': 'dynamic import',
  requires: 'require',
};

function ChangedFileRow({ file }: { file: FileLink }) {
  const imports = file.neighbours.filter((n) => n.direction === 'imports');
  const importers = file.neighbours.filter((n) => n.direction === 'imported-by');
  const files = (list: Neighbour[]) => list.filter((n) => n.nodeKind === 'file');
  const others = imports.filter((n) => n.nodeKind !== 'file');
  return (
    <li className="where-file">
      <p className="where-file-head">
        <span className="where-mark" aria-hidden="true">
          ●
        </span>
        <bdi className="mono where-file-path" title={file.path}>
          {file.relativePath}
        </bdi>
        {file.role && (
          <span className="rp-derived" title={`Inferred: ${file.role.rule}`}>
            test, inferred
          </span>
        )}
        {file.worktree && file.worktree !== file.repository && (
          <span className="where-quiet" title={file.worktree}>
            in worktree {shortHome(file.worktree)}
          </span>
        )}
      </p>
      {file.neighboursTotal === 0 ? (
        <p className="where-none">
          Nothing in the map imports this file, and it imports nothing there. Only JavaScript and
          TypeScript imports are read; C# files are placed by assembly only.
        </p>
      ) : (
        <div className="where-ring1">
          <NeighbourList label="Imports" items={files(imports)} />
          <NeighbourList label="Imported by" items={files(importers)} />
          {others.length > 0 && (
            <p className="where-packages">
              <span className="where-label">Packages</span>{' '}
              {others.map((n, i) => (
                <span key={n.edge} title={n.rule}>
                  {i > 0 ? ', ' : ''}
                  <span className="mono">{n.name ?? n.node}</span>
                </span>
              ))}
            </p>
          )}
          {file.neighboursTruncated && (
            <p className="viz-foot">
              {file.neighboursTotal - file.neighbours.length} more neighbours not shown
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function NeighbourList({ label, items }: { label: string; items: Neighbour[] }) {
  if (items.length === 0) return null;
  return (
    <div className="where-neighbours">
      <p className="where-label">
        {label} <span className="num">{items.length}</span>
      </p>
      <ul className="where-plain">
        {items.map((n) => (
          <li key={n.edge}>
            <bdi className="mono" title={n.path ?? n.node}>
              {n.path ?? n.name ?? n.node}
            </bdi>
            {n.changed && <span className="where-changed">also changed</span>}
            {n.role && (
              <span className="rp-derived" title={`Inferred: ${n.role.rule}`}>
                test, inferred
              </span>
            )}
            {KIND_WORDS[n.kind] && <span className="where-quiet">{KIND_WORDS[n.kind]}</span>}
            <span className="where-rule" title="How the import was resolved">
              {n.rule}
              {n.evidence[0]?.line ? `, line ${n.evidence[0].line}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UnmappedRepository({
  repository,
  files,
  onRetry,
}: {
  repository: RepositoryLink;
  files: FileLink[];
  onRetry?: () => void;
}) {
  const root = repository.root;
  return (
    <section
      className={`where-repo where-unmapped is-${repository.status}`}
      aria-label={`Repository ${root}`}
    >
      <p className="where-at">
        <bdi className="mono" title={root}>
          {shortHome(root)}
        </bdi>
      </p>
      <p className="where-why">{repositoryWords(repository)}</p>
      {repository.status === 'not-opted-in' && (
        <div className="where-optin">
          <p>
            To place these files, allow Salidium to map this repository. It reads committed files
            only, never your working tree, and only when you open this panel.
          </p>
          <pre className="where-command mono">
            <code>salidium map allow {shellWord(root)}</code>
          </pre>
          <p className="where-quiet">
            Undo it any time with{' '}
            <span className="mono">salidium map revoke {shellWord(root)}</span>.
          </p>
        </div>
      )}
      {repository.status === 'map-unavailable' && repository.unavailable === 'busy' && onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
      {files.length > 0 && (
        <ul className="where-plain">
          {files.map((f) => (
            <li key={f.path} className="mono" title={f.path}>
              <bdi>{f.relativePath ?? f.path}</bdi>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
