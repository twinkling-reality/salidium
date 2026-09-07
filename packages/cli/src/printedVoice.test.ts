import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packages = join(import.meta.dirname, '..', '..');
const repository = join(packages, '..');

/*
 * Directories whose contents are not written by hand: dependencies, build output, and the
 * artefacts a test run leaves behind. Walking them is slow and anything found inside is not
 * something a person can fix by editing it.
 */
const SKIPPED = new Set([
  '.git',
  'node_modules',
  'dist',
  'bundle',
  'test-results',
  'playwright-report',
  '.next',
]);

function markdown(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) markdown(path, found);
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) found.push(path);
  }
  return found;
}

/*
 * Source with its comments taken out, so what is left is the text the product can emit.
 *
 * Both substitutions can be fooled: a `//` inside a string truncates that line, and a `/*` inside
 * one opens a block that is not there. Each mistake loses a line rather than inventing a
 * violation, so the guard can miss something but cannot fail for a thing that is fine. That is the
 * safe direction for a rule about wording, and it is why this is a regex and not a parser.
 */
function emittable(source: string): string {
  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) =>
    '\n'.repeat(m.split('\n').length - 1),
  );
  return withoutBlocks.replace(/\/\/[^\n]*/g, '');
}

describe('what the product prints', () => {
  /*
   * No em dash in anything the product can say.
   *
   * The marketing site has had this rule enforced against its rendered HTML for some time; the
   * product never did, and twelve had accumulated across the reducer's check labels, two tooltips,
   * a session row title, the clipboard fallback, the header written into `relay.sh`, and the
   * explainer's own prompt. Comments are left alone: this is about the product's voice, not the
   * codebase's, and the reasoning written above a function is not something a reader ever sees.
   */
  it('never contains an em dash', () => {
    const offenders: string[] = [];
    for (const dir of readdirSync(packages, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      let files: string[];
      try {
        files = sources(join(packages, dir.name, 'src'));
      } catch {
        continue;
      }
      for (const file of files) {
        const lines = emittable(readFileSync(file, 'utf8')).split('\n');
        lines.forEach((line, i) => {
          if (line.includes('—')) offenders.push(`${file.slice(packages.length + 1)}:${i + 1}`);
        });
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * The menu bar is a product surface and was never covered.
   *
   * The rule above walks each package's `src` for `.ts` and `.tsx`. `SalidiumMenuBar.swift` is under
   * `packages/cli/native`, so it sat outside the sweep with four em dashes in the first line of
   * the menu: "Salidium — Healthy" and its three siblings, which is the first thing anyone sees
   * on clicking the icon. Same comment handling, `//` only: the file has no block comments and a
   * Swift string containing `//` would lose a line rather than invent a violation, which is the
   * same safe direction the function above documents.
   */
  it('never contains an em dash in the menu bar either', () => {
    const file = join(packages, 'cli', 'native', 'SalidiumMenuBar.swift');
    const offenders = readFileSync(file, 'utf8')
      .replace(/\/\/[^\n]*/g, '')
      .split('\n')
      .flatMap((line, i) => (line.includes('—') ? [`SalidiumMenuBar.swift:${i + 1}`] : []));
    expect(offenders).toEqual([]);
  });
});

/*
 * The same rule for prose, which had eight and no guard.
 *
 * `using-salidium.md` explained what a notification contains in a sentence with an em dash on each
 * side of the exclusion list, and `CONTRIBUTING.md` opened its review instruction with a pair.
 * These are read by people deciding whether to trust the product and by people about to contribute
 * to it, which makes them a surface even though no process prints them.
 */
describe('what the documentation says', () => {
  it('never contains an em dash', () => {
    const offenders = markdown(repository).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          line.includes('—') ? [`${file.slice(repository.length + 1)}:${i + 1}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
