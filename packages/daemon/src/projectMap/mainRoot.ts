import { join } from 'node:path';
import { RepositoryLocator } from '../enrichers/fileLocation.ts';

/**
 * The main root of the repository that holds a directory: the key every opt-in, map and link uses.
 *
 * It is what `file.located` reports for a changed file in that directory (`mainRoot ?? root`), by
 * the same locator and the same rules, so a linked worktree resolves to the repository it belongs
 * to and nothing is ever keyed by a worktree path. Null when the directory is not inside a
 * repository the locator accepts.
 */
export async function mainRootOf(
  directory: string,
  locator: RepositoryLocator = new RepositoryLocator(),
): Promise<string | null> {
  // The locator places a file; a name that need not exist places the directory itself.
  const located = await locator.locate(join(directory, 'salidium-map-probe'));
  return located ? (located.mainRoot ?? located.root) : null;
}
