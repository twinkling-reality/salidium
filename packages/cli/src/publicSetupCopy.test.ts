import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/*
 * Prose with its line breaks taken out.
 *
 * The README wraps at a hundred columns, so a sentence this file wants to find is split wherever
 * the wrap happens to fall. `/what changed, why, what was verified/` was written against one
 * wrapping of that sentence and was silently unsatisfiable under the next one; it only looked fine
 * because an assertion above it failed first.
 */
const prose = (text: string) => text.replace(/\s+/g, ' ');

/*
 * The promise, taken from the document that owns it rather than written down again here.
 *
 * It was written down again here, and on 2026-08-20 the README was changed to lead with the new
 * line while this file still asserted the old one, so the suite failed on `main` for a copy change
 * that was correct. A test of whether two surfaces agree has to read both of them.
 */
function canonicalPromise(): string {
  const positioning = read('docs/product-positioning.md');
  const promise = /## Canonical promise\s*\n\s*\n> (.+)/.exec(positioning)?.[1];
  if (!promise) throw new Error('docs/product-positioning.md has no canonical promise');
  return promise;
}

describe('public setup instructions', () => {
  it('answers the first-screen product and trust questions before deeper detail', () => {
    const copy = read('README.md');
    const firstSection = copy.slice(0, copy.indexOf('## '));
    expect(firstSection).toMatch(/```bash\nnpx salidium\n```/);

    const opening = prose(firstSection);
    expect(opening).toContain(canonicalPromise());
    expect(opening).toMatch(/Claude Code and Codex/);
    /*
     * No sentence listing what is in a report. Seven were written and every one of them was a
     * four-item list of the report's contents, sitting directly on top of a capture of the report.
     * Measured at the size `capture-demo.mjs` photographs one, the diagrams are 1109 of the page's
     * 1358 pixels; a list cannot beat the picture below it at describing a picture. `package.json`
     * keeps a sentence because npm has no picture to put there instead.
     */
    expect(opening).not.toMatch(/what was verified/);
    expect(opening).toMatch(/open source, and local-first/);
    expect(opening).toMatch(/no Salidium telemetry/);
    expect(opening).toMatch(/Raw transcripts stay local/);
    expect(opening).toMatch(/may contact its provider/);
  });

  it('shows the product on the first screen rather than describing it', () => {
    const copy = read('README.md');
    const firstSection = copy.slice(0, copy.indexOf('## '));

    /*
     * The captures the pipeline writes under stable names, which are the only ones a document
     * outside `apps/site` may reference: the sixteen documentation shots carry a hash of their own
     * bytes in the file name and are renamed by every regeneration.
     *
     * Referenced by repository-relative path, which is the form that resolves everywhere this file
     * is read as a file. The absolute form was tried first and pointed at `main`, so every image
     * was broken in the working tree, in an editor preview, and on any branch that had not landed
     * yet. `packages/cli/build.mjs` makes them absolute for the tarball, where relative would
     * resolve against `packages/cli` instead.
     */
    const captures = ['tour-light.gif', 'tour-dark.gif', 'report-light.png', 'report-dark.png'];
    for (const capture of captures) {
      expect(firstSection).toContain(`="apps/site/public/${capture}"`);
    }
    expect(copy).not.toContain('raw.githubusercontent.com');
    expect(read('packages/cli/build.mjs')).toContain('has no relative image paths left to rewrite');

    /*
     * Every fenced block is a command. This section used to open with a `text` block drawing a
     * two-column table of an agent response beside a Salidium report, which was a picture of the
     * product made of dashes and arrows next to a repository full of photographs of the real one.
     *
     * Every other match closes the block the one before it opened.
     */
    const fences = [...copy.matchAll(/^```(\w*)/gm)].map((m) => m[1]).filter((_, i) => i % 2 === 0);
    expect(fences).toEqual(['bash', 'bash']);
  });

  it('links every documentation page instead of restating it', () => {
    const copy = read('README.md');
    /*
     * Read out of the documentation tree rather than listed here, so a page added to the site
     * without a link from the README is a failure rather than a thing nobody notices.
     */
    const slugs = [...read('apps/site/app/docs/content.ts').matchAll(/^ {4}slug: "([a-z-]+)",$/gm)]
      .map((m) => m[1])
      .toSorted();
    expect(slugs.length).toBeGreaterThan(0);

    const linked = [...copy.matchAll(/https:\/\/salidium\.com\/docs\/([a-z-]+)\)/g)]
      .map((m) => m[1])
      .toSorted();
    expect([...new Set(linked)]).toEqual(slugs);
    expect(copy).toMatch(/\[salidium\.com\/docs\]\(https:\/\/salidium\.com\/docs\)/);
  });

  it('uses one concrete promise in repository and npm metadata', () => {
    const rootPackage = JSON.parse(read('package.json')) as { description: string };
    const cliPackage = JSON.parse(read('packages/cli/package.json')) as { description: string };
    expect(rootPackage.description).toBe(cliPackage.description);
    expect(cliPackage.description).toBe(
      'Turn Claude Code and Codex sessions into a clear, evidence-linked report: what changed, why, what was verified, and what it flagged for a human.',
    );
  });

  it('presents one canonical first-run command immediately and keeps recovery in the guide', () => {
    const copy = read('README.md');
    const guide = read('docs/using-salidium.md');
    expect(copy).toMatch(/^# Salidium[\s\S]*?```bash\nnpx salidium\n```[\s\S]*?## /);
    expect(copy.indexOf('npx salidium')).toBeLessThan(copy.indexOf('## '));
    expect(copy).toMatch(/\[Using Salidium\]\(docs\/using-salidium\.md\)/);
    expect(copy).not.toMatch(/salidium install-hooks|salidium doctor|salidium audit-claims/);
    expect(guide).toMatch(/Later runs start or find the daemon/);
    expect(guide).toMatch(/non-interactive terminal[\s\S]*`--yes`/);
    expect(guide).toMatch(/salidium install-hooks[\s\S]*salidium doctor/);
  });

  it('keeps the landing page free of required recovery commands', () => {
    /*
     * The command lives in `Showcase.tsx`: `page.tsx` is the route and holds only the layout.
     *
     * The npx/pnpm pair this used to assert is deliberately gone. The landing page offers one
     * command and one control, and its own test forbids `pnpm dlx` from the rendered page, so the
     * two suites asserted opposite things about the same screen. What this guards is unchanged:
     * exactly one canonical first-run command, and no recovery command on the way in.
     */
    const showcase = read('apps/site/app/Showcase.tsx');
    expect(showcase).toMatch(/const COMMAND = "npx salidium"/);
    expect(showcase.match(/npx salidium/g)).toHaveLength(1);
    expect(showcase).not.toMatch(/pnpm dlx/);
    expect(showcase).not.toMatch(/install-hooks|salidium doctor/);
  });

  it('describes onboarding and automation flags in CLI help', () => {
    const main = read('packages/cli/src/main.ts');
    expect(main).toMatch(/Connect detected agents on first run/);
    expect(main).toMatch(/--yes, -y\s+Approve detected provider configuration/);
    expect(main).toMatch(/--no-open\s+Start Salidium without opening a browser/);
  });
});
