/*
 * Experimental project map of one Git revision. Not part of the product; see
 * docs/project-map-validation.md for what it was built to test and what it found.
 *
 *   node scripts/project-map/index-repository.mjs <repository> <revision> [--out map.json]
 *
 * Prints a coverage and cost summary as one JSON line. With --out, writes the full map.
 */
import { writeFileSync } from 'node:fs';
import { buildProjectMap } from './build.mjs';

const [repo, revision] = process.argv.slice(2);
if (!repo || !revision) {
  process.stderr.write('usage: index-repository.mjs <repository> <revision> [--out map.json]\n');
  process.exit(2);
}
const outFlag = process.argv.indexOf('--out');
const map = buildProjectMap(repo, revision);
const serialized = JSON.stringify(map);
if (outFlag > 0) writeFileSync(process.argv[outFlag + 1], serialized);
process.stdout.write(
  `${JSON.stringify({
    repository: map.repository,
    cost: { ...map.cost, mapBytes: Buffer.byteLength(serialized) },
    nodes: map.nodes.length,
    edges: map.edges.length,
    coverage: map.coverage,
  })}\n`,
);
