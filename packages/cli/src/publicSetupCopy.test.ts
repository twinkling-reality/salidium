import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');

describe('public setup instructions', () => {
  it('presents one canonical first-run command and keeps recovery commands secondary', () => {
    const copy = readFileSync(join(root, 'README.md'), 'utf8');
    expect(copy).toMatch(/## Run it[\s\S]*?```bash\nnpx salidium\n```/);
    expect(copy).toMatch(/same command starts or finds the daemon/);
    expect(copy).toMatch(/non-interactive terminal[\s\S]*`--yes`/);
    expect(copy).toMatch(/manual setup and recovery/);
    expect(copy).not.toMatch(
      /```bash\nnpx salidium[^\n]*\nnpx salidium install-hooks[^\n]*\nnpx salidium doctor/,
    );
  });

  it('keeps the landing page free of required recovery commands', () => {
    const page = readFileSync(join(root, 'apps/site/app/page.tsx'), 'utf8');
    expect(page).toMatch(/npx: "npx salidium"/);
    expect(page).toMatch(/pnpm: "pnpm dlx salidium"/);
    expect(page.match(/npx salidium/g)).toHaveLength(1);
    expect(page).not.toMatch(/install-hooks|salidium doctor/);
  });

  it('describes onboarding and automation flags in CLI help', () => {
    const main = readFileSync(join(root, 'packages/cli/src/main.ts'), 'utf8');
    expect(main).toMatch(/Connect detected agents on first run/);
    expect(main).toMatch(/--yes, -y\s+Approve detected provider configuration/);
    expect(main).toMatch(/--no-open\s+Start Salidium without opening a browser/);
  });
});
