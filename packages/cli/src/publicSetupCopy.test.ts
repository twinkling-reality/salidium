import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');

describe('public setup instructions', () => {
  it('answers the first-screen product and trust questions before deeper detail', () => {
    const copy = readFileSync(join(root, 'README.md'), 'utf8');
    const firstSection = copy.slice(0, copy.indexOf('## '));
    expect(firstSection).toMatch(/Understand what your coding agent did/);
    expect(firstSection).toMatch(/Claude Code and Codex sessions/);
    expect(firstSection).toMatch(/what changed, why, what was verified, and what needs you/);
    expect(firstSection).toMatch(/```bash\nnpx salidium\n```/);
    expect(firstSection).toMatch(/open source, and local-first/);
    expect(firstSection).toMatch(/no Salidium telemetry/);
    expect(firstSection).toMatch(/Raw transcripts stay local/);
    expect(firstSection).toMatch(/may contact its provider/);

    const capabilities = copy.slice(
      copy.indexOf('Salidium gives you:'),
      copy.indexOf('Supported agents:'),
    );
    expect(capabilities.match(/^- /gm)).toHaveLength(5);
  });

  it('uses one concrete promise in repository and npm metadata', () => {
    const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      description: string;
    };
    const cliPackage = JSON.parse(
      readFileSync(join(root, 'packages/cli/package.json'), 'utf8'),
    ) as { description: string };
    expect(rootPackage.description).toBe(cliPackage.description);
    expect(cliPackage.description).toBe(
      'Turn Claude Code and Codex sessions into a clear, evidence-linked report of what changed, why, what was verified, and what needs you.',
    );
  });

  it('presents one canonical first-run command immediately and keeps recovery in the guide', () => {
    const copy = readFileSync(join(root, 'README.md'), 'utf8');
    const guide = readFileSync(join(root, 'docs/using-salidium.md'), 'utf8');
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
    const showcase = readFileSync(join(root, 'apps/site/app/Showcase.tsx'), 'utf8');
    expect(showcase).toMatch(/const COMMAND = "npx salidium"/);
    expect(showcase.match(/npx salidium/g)).toHaveLength(1);
    expect(showcase).not.toMatch(/pnpm dlx/);
    expect(showcase).not.toMatch(/install-hooks|salidium doctor/);
  });

  it('describes onboarding and automation flags in CLI help', () => {
    const main = readFileSync(join(root, 'packages/cli/src/main.ts'), 'utf8');
    expect(main).toMatch(/Connect detected agents on first run/);
    expect(main).toMatch(/--yes, -y\s+Approve detected provider configuration/);
    expect(main).toMatch(/--no-open\s+Start Salidium without opening a browser/);
  });
});
