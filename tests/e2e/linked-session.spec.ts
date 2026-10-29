import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures.ts';

const FANOUT = 'claude-code:e2e-fanout';
const FANOUT_TITLE = 'Find the unbounded queries';

/**
 * A page on another site that links to one Salidium session, the way a dashboard on the web does.
 * `localhost` is a different site from `127.0.0.1`: the host differs, not only the port, so the
 * browser marks the navigation it starts as cross-site.
 */
async function linkingSite(target: string) {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><title>Another site</title><a href="${target}" target="_blank" rel="noopener noreferrer">Open report</a>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://localhost:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('a link on another site opens the session it names in a new tab', async ({
  context,
  page,
  daemon,
}) => {
  // Sign in once, the way `salidium open` does.
  await page.goto(`${daemon.url}/#token=${daemon.token}`);
  await expect(page.locator('h1.masthead-title')).toHaveText('Improve checkout safeguards');

  const site = await linkingSite(`${daemon.url}/#/s/${encodeURIComponent(FANOUT)}`);
  try {
    await page.goto(site.url);
    const [opened] = await Promise.all([
      context.waitForEvent('page'),
      page.getByRole('link', { name: 'Open report' }).click(),
    ]);
    await expect(opened.locator('h1.masthead-title')).toHaveText(FANOUT_TITLE);
    await expect(opened.getByLabel('Daemon token, or a URL containing it')).toHaveCount(0);
    // The site that linked here keeps no handle on the window it opened.
    expect(await opened.evaluate(() => window.opener)).toBeNull();
  } finally {
    await site.close();
  }
});

test('the session a link names survives the token gate', async ({ browser, daemon }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`${daemon.url}/#/s/${encodeURIComponent(FANOUT)}`);
    const field = page.getByLabel('Daemon token, or a URL containing it');
    await expect(field).toBeVisible();
    await field.fill(daemon.token);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.locator('h1.masthead-title')).toHaveText(FANOUT_TITLE);
  } finally {
    await context.close();
  }
});
