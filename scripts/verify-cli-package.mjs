import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '');
if (!process.argv[2])
  throw new Error('usage: node scripts/verify-cli-package.mjs PACKAGE_DIRECTORY');

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.equal(manifest.name, 'salidium');
assert.equal(manifest.license, 'MIT');
assert.equal(manifest.engines?.node, '>=24.0.0');
assert.deepEqual(manifest.bin, { salidium: 'bundle/salidium.mjs' });
assert.deepEqual(manifest.files, ['bundle', 'THIRD_PARTY_NOTICES']);
assert.equal(manifest.exports, undefined, 'CLI package must not advertise an import surface');
assert.equal(manifest.main, undefined, 'CLI package must not advertise an import surface');
assert.equal(manifest.dependencies, undefined, 'published CLI must remain self-contained');
assert.equal(manifest.optionalDependencies, undefined, 'published CLI must remain self-contained');

assert.deepEqual(readdirSync(root).sort(), [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES',
  'bundle',
  'package.json',
]);
assert.deepEqual(readdirSync(resolve(root, 'bundle')).sort(), ['native', 'salidium.mjs', 'ui']);
assert.deepEqual(readdirSync(resolve(root, 'bundle/native')).sort(), ['SalidiumMenuBar.swift']);

const runtime = readFileSync(resolve(root, 'bundle/salidium.mjs'), 'utf8');
assert.ok(
  runtime.startsWith('#!/usr/bin/env node\n'),
  'CLI bundle needs a valid first-line shebang',
);
assert.ok(readFileSync(resolve(root, 'bundle/ui/index.html'), 'utf8').includes('<!doctype html>'));

const notices = readFileSync(resolve(root, 'THIRD_PARTY_NOTICES'), 'utf8');
for (const dependency of [
  'Zod 4.4.3',
  'React 19.2.8',
  'Scheduler 0.27.0',
  'Zustand 5.0.15',
  'TanStack React Virtual 3.14.9',
  'TanStack Virtual Core 3.17.7',
  'Vite 8.2.1',
  'Rolldown 1.2.4',
  'esbuild 0.28.2',
  'Rollup-derived portions',
])
  assert.ok(notices.includes(dependency), `third-party notice is missing ${dependency}`);
assert.ok(notices.includes('Permission is hereby granted'));

process.stdout.write(
  `verified ${manifest.name}@${manifest.version} package contents and notices\n`,
);
