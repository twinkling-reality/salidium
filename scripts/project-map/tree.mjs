/*
 * Reads one Git revision's tracked tree: paths, blob ids, sizes and, for the files the indexer
 * parses, contents. It never looks at the working tree, so ignored, untracked and uncommitted
 * files cannot enter the map, and two runs at the same revision read the same bytes.
 */
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * @typedef {{ path: string, blob: string, bytes: number, mode: string }} TreeEntry
 */

/** @param {string} repo @param {string} revision */
export function resolveRevision(repo, revision) {
  const commit = execFileSync(
    'git',
    ['-C', repo, 'rev-parse', '--verify', `${revision}^{commit}`],
    {
      encoding: 'utf8',
    },
  ).trim();
  const tree = execFileSync('git', ['-C', repo, 'rev-parse', `${commit}^{tree}`], {
    encoding: 'utf8',
  }).trim();
  const committedAt = execFileSync('git', ['-C', repo, 'show', '-s', '--format=%cI', commit], {
    encoding: 'utf8',
  }).trim();
  return { commit, tree, committedAt };
}

/** @param {string} repo @param {string} commit @returns {TreeEntry[]} */
export function listTree(repo, commit) {
  const out = execFileSync('git', ['-C', repo, 'ls-tree', '-r', '-l', '-z', commit], {
    maxBuffer: 256 * 1024 * 1024,
  }).toString('utf8');
  /** @type {TreeEntry[]} */
  const entries = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, blob, size] = record.slice(0, tab).split(/\s+/);
    if (type !== 'blob') continue; // submodules are commits, not files of this tree
    entries.push({ path: record.slice(tab + 1), blob, bytes: Number(size), mode });
  }
  return entries;
}

/**
 * Contents of the given blobs, read in one `git cat-file --batch` process.
 * @param {string} repo @param {string[]} blobs @returns {Map<string, string>}
 */
export function readBlobs(repo, blobs) {
  const unique = [...new Set(blobs)];
  const contents = new Map();
  if (unique.length === 0) return contents;
  const result = spawnSync('git', ['-C', repo, 'cat-file', '--batch'], {
    input: `${unique.join('\n')}\n`,
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git cat-file failed: ${result.stderr}`);
  const buffer = result.stdout;
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(10, offset);
    const header = buffer.subarray(offset, newline).toString('utf8');
    const [blob, type, size] = header.split(' ');
    offset = newline + 1;
    if (type === 'missing') continue;
    const length = Number(size);
    contents.set(blob, buffer.subarray(offset, offset + length).toString('utf8'));
    offset += length + 1;
  }
  return contents;
}
