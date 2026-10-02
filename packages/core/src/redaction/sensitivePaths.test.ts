import { describe, expect, it } from 'vitest';
import {
  isCredentialDumpCommand,
  isSensitiveMcpFileRead,
  isSensitivePath,
  isSensitiveUri,
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
    ['a stray percent in a URI', 'file:///repo/notes/100%/readme.md'],
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

  it.each([
    '/repo/docs/100%.md',
    '/repo/docs/50%off.md',
    '/repo/notes/100%/.envrc-not',
    '/repo/%ZZ/readme.md',
    'C:\\repo\\100%\\a.ts',
  ])('reads a malformed escape in the native path %s as a literal percent', (path) => {
    expect(isSensitivePath(path)).toBe(false);
  });

  it('still decodes valid escapes in a native path, and checks the rest literally', () => {
    expect(isSensitivePath('/repo/%2Eenv')).toBe(true);
    expect(isSensitivePath('/repo/100%/%2Eenv')).toBe(true);
    expect(isSensitivePath('/repo/100%/.ENV.')).toBe(true);
  });

  it.each(['/repo/%ZZ/readme.md', '100%.md', 'file:///repo/%E0%A4%A'])(
    'treats a malformed escape in the URI value %s as sensitive',
    (value) => {
      expect(isSensitiveUri(value)).toBe(true);
    },
  );

  it('reads a web address as a path, since no tool opens it as a file', () => {
    expect(isSensitiveUri('https://x/?q=100%')).toBe(false);
    expect(isSensitiveUri('https://example.com/%E0%A4%A')).toBe(false);
    expect(isSensitiveUri('https://example.com/%2Eenv')).toBe(true);
  });

  it('reads a well-formed URI value as its path', () => {
    expect(isSensitiveUri('file:///repo/src/%63onfig.ts')).toBe(false);
    expect(isSensitiveUri('/repo/docs/100%25.md')).toBe(false);
    expect(isSensitiveUri('file:///repo/%2Eenv')).toBe(true);
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

  it('fails closed on a malformed escape under a URI key only', () => {
    expect(read(JSON.stringify({ uri: '/repo/%ZZ/readme.md' }))).toBe(true);
    expect(read(JSON.stringify({ url: 'file:///repo/%E0%A4%A' }))).toBe(true);
    expect(read(JSON.stringify({ request: { hrefs: ['/repo/a.ts', '/repo/100%.md'] } }))).toBe(
      true,
    );
    expect(read(JSON.stringify({ path: '/repo/%ZZ/readme.md' }))).toBe(false);
    expect(read(JSON.stringify({ paths: ['/repo/docs/100%.md'] }))).toBe(false);
    expect(read('{"uri":"/repo/%ZZ/readme.md","padding":"xx')).toBe(true);
    expect(read('{"path":"/repo/%ZZ/readme.md","padding":"xx')).toBe(false);
    expect(read('{}', ['/repo/%ZZ/readme.md'])).toBe(false);
    expect(
      isSensitiveMcpFileRead({
        kind: 'mcp',
        server: 'filesystem',
        tool: 'read_file',
        pathArgs: ['/repo/%ZZ/readme.md'],
        pathArgsUndecodable: true,
      }),
    ).toBe(true);
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

describe('shell commands that print a sensitive file', () => {
  it.each([
    // Prefixes that run the command after them.
    'sudo cat .env',
    'sudo -u root cat /root/.ssh/id_rsa',
    'sudo -E -n cat .env',
    'env cat .env',
    'env FOO=1 -u BAR cat .env',
    "env -S 'cat .env'",
    'command cat .env',
    'nice -n 10 cat .env',
    'time cat .env',
    'time -p cat .env',
    'timeout 5 cat .env',
    'nohup cat .env',
    'doas cat .env',
    'stdbuf -oL cat .env',
    'echo .env | xargs cat',
    'find . -name .env -print0 | xargs -0 cat',
    'printf "%s\\n" .env | xargs -I{} sudo cat {}',
    // Readers.
    ...['tac', 'nl', 'base64', 'xxd', 'od -c', 'hexdump -C', 'strings', 'head', 'tail', 'less']
      .concat(['more', 'bat', 'sort', 'uniq', 'cut -d= -f2', 'diff a.txt', 'jq .'])
      .map((reader) => `${reader} .env`),
    'dd if=.env',
    "grep -E 'KEY|TOKEN' .env",
    'grep -e KEY .env*',
    'grep -r KEY ~/.aws',
    'rg --files-with-matches KEY ~/.ssh',
    // Input redirection from a sensitive file.
    '< .env cat',
    'cat < .env',
    'cat 0<.env',
    'sort <.env',
    'while read -r line; do echo "$line"; done < .env',
    'echo "$(< .env)"',
    // Globs that match sensitive names.
    'cat .env*',
    'cat .env.*',
    'cat *.pem',
    'cat certs/*.key',
    'cat id_*',
    'cat ~/.ssh/id_*',
    'cat ~/.ssh/*',
    'cat .[e]nv',
    'cat .env{,.local}',
    'cat ~/.AWS/*',
    // Git objects named by path.
    'git show HEAD:.env',
    'git show :.env',
    'git show HEAD~1:./.ENV',
    'git cat-file -p HEAD:.env',
    'git cat-file blob main:config/.env.production',
    'git -C repo --no-pager show main:.npmrc',
    'git diff HEAD -- .env',
    'git log -p -- .env',
    // Scripts inside scripts.
    'echo $(cat .env)',
    'echo `cat .env`',
    'diff <(cat .env) .env.example',
    '(cat .env)',
    '{ cat .env; }',
    'if true; then cat .env; fi',
    "bash -c 'cat .env'",
    'sh -lc "sudo cat .env"',
    'eval "cat .env"',
    "find . -name '.env*' -exec cat {} ;",
    'find ~/.ssh -type f -exec cat {} +',
  ])('suppresses %s', (command) => {
    expect(isCredentialDumpCommand(command)).toBe(true);
  });

  it.each([
    'grep -rn TODO *',
    'grep -rn TODO .',
    'cat *.ts',
    'head -n 5 src/*.md',
    "grep -E '.*foo.*' src/a.ts",
    "rg -i '.*TODO.*' src",
    "sed 's/.*/x/' notes.txt",
    "awk '/.env/ {print}' .gitignore.bak",
    'cat .gitignore',
    'tail -f logs/server.log',
    'cat < input.txt',
    'ls -la .env',
    'git add .env',
    'git show HEAD:src/a.ts',
    'git diff',
    'echo .env >> .gitignore',
    'cat <<EOF\nnot a file\nEOF',
    'sudo ls /root',
    "find . -name '*.tmp' | xargs rm",
    'timeout 5 node server.js',
    'xargs cat < files.txt',
  ])('leaves %s alone', (command) => {
    expect(isCredentialDumpCommand(command)).toBe(false);
  });
});

describe('globs name a sensitive file only through a distinctive stem', () => {
  it.each([
    ['*secret*.json', true],
    ['auth*.json', true],
    ['.env*', true],
    ['.env.*', true],
    ['.[e]nv', true],
    ['*.pem', true],
    ['certs/*.key', true],
    ['id_*', true],
    ['~/.ssh/*', true],
    ['~/.aws/cred*', true],
    ['.npm*rc', true],
    ['*credential*', true],
    ['service-account-*.json', true],
    ['*.json', false],
    ['package*.json', false],
    ['tsconfig*.json', false],
    ['*.yaml', false],
    ['config/*.yml', false],
    ['*.ts', false],
    ['src/**/*.tsx', false],
    ['*', false],
    ['.en?', true],
    ['.*rc', true],
    ['.en*', true],
    ['.e*', true],
    ['.*', true],
    ['cred*', true],
    ['.git-cred*', true],
    ['*.ke?', true],
    ['.pg*', true],
    ['.my.c*', true],
    ['~/.s*/*', true],
    ['~/.kube/*', true],
    ['~/.codex/*', true],
    ['~/.docker/*', true],
    ['.github/*', false],
    ['.config/*.yml', false],
    ['*.js', false],
    ['*.tf', false],
    ['environment*.ts', false],
    ['docs/env-*.md', false],
  ])('cat %s: %s', (glob, sensitive) => {
    expect(isCredentialDumpCommand(`cat ${glob}`)).toBe(sensitive);
  });
});

describe('shell syntax the first review missed', () => {
  it.each([
    'cat .e\\\nnv',
    'ca\\\nt .env',
    'cat .e\\\r\nnv',
    'sudo -Eu root cat .env',
    'sudo -nEu root cat /root/.ssh/id_rsa',
    'env -iu X cat .env',
    'env - cat .env',
    'env -iu X',
    'set',
    'export',
    'export -p',
    'declare -x',
    'grep -f .env src/a.ts',
    'grep --file=.env src/a.ts',
    'git log -L1,9:.env',
    'git grep -f .env',
    'git show HEAD -- .env',
  ])('suppresses %s', (command) => {
    expect(isCredentialDumpCommand(command)).toBe(true);
  });

  it.each([
    'grep --exclude=.env -r KEY .',
    'grep --exclude .env -r KEY .',
    'grep --exclude-dir=.ssh -r KEY .',
    "rg -g '!.env' KEY",
    "rg --glob '!.env*' KEY src",
    "awk '/\\.env/' a.txt",
    "git grep '\\.env'",
    "git grep -e '.env' -- src",
    "git log -S '.env'",
    "git log --grep='.env'",
    "git log --author='.env bot'",
    "rg 'process\\.env\\.' src",
    "grep -rn 'process\\.env' src",
    "grep -e '\\.env' src/a.ts",
    "sed -e 's/.env/x/' notes.txt",
    "jq '.env' package.json",
    'set -e; npm test',
    'set -euo pipefail',
    'export FOO=1 && npm test',
    'echo a | xargs cat',
  ])('leaves %s alone', (command) => {
    expect(isCredentialDumpCommand(command)).toBe(false);
  });

  it('reads an xargs pipeline once, however many readers it has', () => {
    const words = Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join(' ');
    const command = `echo ${words} | ${'xargs cat; '.repeat(1000)}`;
    let best = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      expect(isCredentialDumpCommand(command)).toBe(false);
      best = Math.min(best, performance.now() - started);
    }
    // The per-segment rescan took over a second; once per command it is a few milliseconds.
    expect(best).toBeLessThan(250);
  });
});
