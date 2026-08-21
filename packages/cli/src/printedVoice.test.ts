import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const packages = join(import.meta.dirname, '..', '..');

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
});
