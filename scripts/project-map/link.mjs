/*
 * Links one execution's changed files to the nodes of a project map.
 *
 * The consumer v1 session report gives absolute paths and the session's repository root. A path
 * becomes a node only when it lies under that root and the map's revision tracks it; everything
 * else keeps a status that says why it did not link. Nothing is matched by name or similarity.
 */
import { posix } from 'node:path';

/**
 * @typedef {'node' | 'not-in-map' | 'outside-repository' | 'repository-unknown'} LinkStatus
 * @param {{ nodes: Array<{ id: string, kind: string, path?: string }>, edges: Array<{ from: string, to: string, kind: string }> }} map
 * @param {{ repositoryRoot: string | null, files: Array<{ path: string }> }} execution
 */
export function linkChangedFiles(map, execution) {
  const byPath = new Map(map.nodes.filter((n) => n.kind === 'file').map((n) => [n.path, n]));
  const degree = new Map();
  for (const edge of map.edges) {
    if (!edge.from.startsWith('file:') || !edge.to.startsWith('file:')) continue;
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const root = execution.repositoryRoot?.replace(/\/+$/, '') ?? null;
  return execution.files.map((file) => {
    if (root === null)
      return { path: file.path, status: /** @type {LinkStatus} */ ('repository-unknown') };
    if (!file.path.startsWith(`${root}/`)) return { path: file.path, status: 'outside-repository' };
    const relative = posix.normalize(file.path.slice(root.length + 1));
    const node = byPath.get(relative);
    if (!node) return { path: file.path, relative, status: 'not-in-map' };
    return {
      path: file.path,
      relative,
      status: 'node',
      node: node.id,
      neighbors: degree.get(node.id) ?? 0,
    };
  });
}
