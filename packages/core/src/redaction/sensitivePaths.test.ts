import { describe, expect, it } from 'vitest';
import {
  isCredentialDumpCommand,
  isSensitiveMcpFileRead,
  isSensitivePath,
} from './sensitivePaths.ts';

/** Every basename in the sensitive list, and a file under each sensitive directory or suffix. */
const SENSITIVE_NAMES = [
  '.env',
  '.envrc',
  '.flaskenv',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.pgpass',
  '.my.cnf',
  '.git-credentials',
  'auth.json',
  'credentials',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'known_hosts',
  '.claude.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  '.env.local',
  'server.pem',
  'release.p12',
  'id_rsa.pub',
  '.ssh/config',
  '.aws/config',
  '.gnupg/pubring.kbx',
  '.config/gcloud/application_default_credentials.json',
  '.kube/config',
  '.docker/config.json',
  'service-account-prod.json',
  '.claude/settings.local.json',
  '.codex/config.toml',
  'app-secret.yaml',
];

const hex = (char: string) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
const encodeAll = (name: string) =>
  [...name].map((char) => (char === '/' ? char : hex(char))).join('');

/** Spellings of `/repo/<name>` a tool might open as that file, none of them literally equal. */
function encodedVariants(name: string): Array<[string, string]> {
  const first = name[0] ?? '';
  const rest = name.slice(1);
  const lastSlash = name.lastIndexOf('/');
  const dir = name.slice(0, lastSlash + 1);
  const base = name.slice(lastSlash + 1);
  return [
    ['file URI', `file:///repo/${name}`],
    ['file URI with a host', `file://localhost/repo/${name}`],
    ['file URI with a query and a fragment', `file:///repo/${name}?v=1#top`],
    ['encoded first character', `file:///repo/${hex(first)}${rest}`],
    ['lower-case escape', `file:///repo/${hex(first).toLowerCase()}${rest}`],
    ['encoded second character', `file:///repo/${first}${hex(rest[0] ?? '')}${rest.slice(1)}`],
    ['every character encoded', `file:///repo/${encodeAll(name)}`],
    ['encoded separator', `file:///repo${hex('/')}${name}`],
    ['double encoding', `file:///repo/%25${hex(first).slice(1)}${rest}`],
    ['encoded plain path', `/repo/${hex(first)}${rest}`],
    ['upper case', `/REPO/${name.toUpperCase()}`],
    ['trailing dot', `/repo/${name}.`],
    ['trailing dot and space', `/repo/${name}. `],
    ['doubled separators', `/repo//${name.replaceAll('/', '//')}`],
    ['dot segment', `/repo/./${dir}./${base}`],
    ['parent segment', `/repo/src/../${name}`],
    ['backslashes', `C:\\repo\\${name.replaceAll('/', '\\')}`],
    ['encoded backslash', `file:///C:/repo${hex('\\')}${name}`],
    ['alternate data stream', `C:\\repo\\${name.replaceAll('/', '\\')}::$DATA`],
    ['NUL suffix', `file:///repo/${name}%00.txt`],
  ];
}

describe('sensitive path normalization', () => {
  for (const name of SENSITIVE_NAMES) {
    it.each(encodedVariants(name))(`recognizes ${name} given as a %s`, (_label, path) => {
      expect(isSensitivePath(path)).toBe(true);
    });
  }

  it.each([
    '/repo/src/env.ts',
    '/repo/README.md',
    '/repo/src/environment.ts',
    '/repo/docs/known_hosts.md',
    '/repo/src/auth.json.ts',
    '/repo/src/keys.tsx',
    '/repo/.envoy/listener.yaml',
    '/repo/.sshd/notes.md',
    'file:///repo/src/config.ts',
    'file://localhost/repo/src/%E2%9C%93.md',
    'file:///repo/docs/100%25.md',
    '/repo/My%20Documents/report.pdf',
    '/repo/./src//a.ts',
    '/repo/src/../lib/a.ts.',
    'C:\\repo\\src\\a.ts',
  ])('leaves an ordinary path alone: %s', (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  it.each([
    ['a stray percent', '/repo/notes/100%/.envrc-not'],
    ['a truncated escape', 'file:///repo/%2'],
    ['a non-hex escape', 'file:///repo/%ZZenv'],
    ['an incomplete UTF-8 sequence', 'file:///repo/%E0%A4%A.txt'],
    ['an overlong UTF-8 dot', 'file:///repo/%C0%AEenv'],
    ['encoding nested past the bound', `file:///repo/%25${'25'.repeat(9)}2Eenv`],
  ])('treats %s as sensitive rather than safe', (_label, path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it.each([
    ['a tab in a URI', 'file:///repo/.e\tnv'],
    ['a newline in a URI', 'file:///Users/me/.a\nws/config'],
    ['a carriage return in a URI', 'file:///repo/.e\rnv'],
    ['a trailing control character in a URI', 'file:///repo/.env\u0001'],
    ['leading spaces before a URI', '  file:///repo/.env'],
    ['a trailing newline', '/repo/.env\n'],
    ['a trailing tab', '/repo/.npmrc\t'],
    ['a leading space', ' .env'],
    ['a Windows drive-relative path', 'C:.env'],
    ['a drive-relative key', 'c:id_rsa'],
    ['a drive-relative directory', 'D:.ssh\\config'],
    ['a directory stream', 'C:\\Users\\me\\.aws::$INDEX_ALLOCATION\\config'],
    ['a named directory stream', 'C:\\Users\\me\\.ssh:$I30:$INDEX_ALLOCATION\\id_rsa'],
    ['a path longer than any real one', `/repo/${'a/'.repeat(2100)}notes.md`],
  ])('recognizes %s', (_label, path) => {
    expect(isSensitivePath(path)).toBe(true);
  });

  it('bounds the work a hostile path list can cause', () => {
    const hostile = Array.from({ length: 32 }, (_, i) =>
      `/${i}${'secret'.repeat(150)}%252525252525252541`.slice(0, 1000),
    );
    const started = performance.now();
    isSensitiveMcpFileRead({ kind: 'mcp', server: 'fs', tool: 'read_file', pathArgs: hostile });
    // Generous: the unbounded version took over a second; this guards the order of magnitude.
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('decodes nested encoding within the bound', () => {
    expect(isSensitivePath('file:///repo/%25252Eenv')).toBe(true);
    expect(isSensitivePath('file:///repo/%25252Etxt')).toBe(false);
  });
});

describe('sensitive file output from a shell command', () => {
  it.each([
    'cat .ENV',
    'cat ./.env.',
    'head -n1 .//.ssh/id_rsa',
    'tail /home/me/.AWS/credentials',
    'cat src/../.env.production',
    'grep KEY ~/.KUBE/config',
    "cat $'.env'",
    "cat $'\\x2eenv'",
    "cat $'\\056env'",
    "cat $'\\u002eenv'",
    'cat $".env"',
  ])('suppresses %s', (command) => {
    expect(isCredentialDumpCommand(command)).toBe(true);
  });

  it.each([
    `awk '{printf "%s\\n", $1}' data.csv`,
    "grep -E '100%' notes.md",
    "sed 's/%d/N/' src/format.ts",
    'cat 100%.txt',
    "cat $'notes\\x2etxt'",
  ])('reads a literal percent in %s and does not suppress it', (command) => {
    expect(isCredentialDumpCommand(command)).toBe(false);
  });
});

describe('MCP read arguments', () => {
  const read = (argsExcerpt: string, pathArgs?: string[]) =>
    isSensitiveMcpFileRead({
      kind: 'mcp',
      server: 'filesystem',
      tool: 'read_file',
      argsExcerpt,
      ...(pathArgs ? { pathArgs } : {}),
    });

  it('normalizes path metadata and parsed arguments', () => {
    expect(read('{}', ['file:///repo/%2Eenv'])).toBe(true);
    expect(read(JSON.stringify({ uri: 'file:///repo/.%65nv' }))).toBe(true);
    expect(read(JSON.stringify({ request: { uris: ['file:///Repo//./ID_RSA.'] } }))).toBe(true);
    expect(read(JSON.stringify('file:///repo/%2Essh/id_ed25519'))).toBe(true);
    expect(read(JSON.stringify({ uri: 'file:///repo/src/config.ts' }))).toBe(false);
  });

  it('treats read_media_file as a read', () => {
    expect(
      isSensitiveMcpFileRead({
        kind: 'mcp',
        server: 'filesystem',
        tool: 'read_media_file',
        argsExcerpt: JSON.stringify({ path: '/repo/.env' }),
      }),
    ).toBe(true);
  });

  it('recovers an encoded path from a clipped excerpt, alone or in a list', () => {
    expect(read('{"uri":"file:///repo/%2Eenv","padding":"xx')).toBe(true);
    expect(read('{"paths":["/repo/a.ts","file:///repo/.%65nv"],"padding":"xx')).toBe(true);
    expect(read('{"path":"/repo/it\\"s/.ENV","padding":"xx')).toBe(true);
    expect(read('{"path":"/repo/\\u002eenv","padding":"xx')).toBe(true);
    expect(read('{"paths":["/repo/a.ts","/repo/b.ts"],"padding":"xx')).toBe(false);
  });
});
