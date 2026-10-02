import type { ProjectMap } from '@salidium/project-map';
import { type BlobEntry, buildProjectMap, type MapBounds } from './build.ts';
import type { GitObjectReader } from './gitObjects.ts';

/**
 * A map of one commit read through a hardened reader: the commit, its tree listing, every blob's
 * size from its header, and then only the contents the builder asks for. Null when the object
 * store holds no commit with that id.
 */
export async function mapFromObjectStore(options: {
  reader: GitObjectReader;
  root: string;
  commit: string;
  bounds: MapBounds;
  now?: () => number;
  /** Whether the opt-in this build serves still stands; checked between reads. */
  current?: () => boolean;
}): Promise<ProjectMap | null | 'revoked'> {
  const { reader, bounds } = options;
  const current = options.current ?? (() => true);
  const commit = await reader.commit(options.commit);
  if (!commit) return null;
  const git = await reader.version();
  if (!current()) return 'revoked';
  const tree = await reader.listTree(commit.tree, bounds.files);
  if (!current()) return 'revoked';
  const listed = tree.filter((e) => e.type === 'blob');
  const sizes = await reader.check([...new Set(listed.map((e) => e.oid))]);
  if (!current()) return 'revoked';
  const blobs: BlobEntry[] = listed.map((e) => {
    const header = sizes.get(e.oid);
    return {
      path: e.path,
      mode: e.mode,
      oid: e.oid,
      bytes: header && header.type === 'blob' ? header.bytes : null,
    };
  });
  return buildProjectMap({
    root: options.root,
    commit: options.commit,
    tree: commit.tree,
    commitTime: commit.commitTime,
    git,
    blobs,
    submodules: tree.filter((e) => e.type === 'commit').map((e) => e.path),
    read: (objects) => reader.read(objects),
    bounds,
    ...(options.now ? { now: options.now } : {}),
  });
}
