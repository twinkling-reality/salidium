/**
 * Builds a synthetic Claude Code transcript with the exact record shapes observed in
 * Claude Code 2.1.2xx session files (keys and nesting), without any real user content.
 */
export interface SyntheticOptions {
  sessionId?: string;
  cwd?: string;
  version?: string;
}

export function buildSyntheticTranscript(opts: SyntheticOptions = {}): {
  sessionId: string;
  lines: string[];
  ids: Record<string, string>;
} {
  const sessionId = opts.sessionId ?? '11111111-2222-4333-8444-555555555555';
  const cwd = opts.cwd ?? '/repo/app';
  const version = opts.version ?? '2.1.233';
  let t = Date.parse('2026-08-16T10:30:00.000Z');
  const ts = (s = 5) => {
    t += s * 1000;
    return new Date(t).toISOString();
  };
  const env = (extra: Record<string, unknown>) => ({
    cwd,
    sessionId,
    version,
    gitBranch: 'main',
    userType: 'external',
    entrypoint: 'cli',
    isSidechain: false,
    ...extra,
  });
  const promptId = 'aaaaaaaa-0000-4000-8000-000000000001';
  const promptId2 = 'aaaaaaaa-0000-4000-8000-000000000002';
  const ids = {
    promptId,
    promptId2,
    bash1: 'toolu_01AAAA',
    edit1: 'toolu_01BBBB',
    bash2: 'toolu_01CCCC',
    write1: 'toolu_01DDDD',
    task1: 'toolu_01EEEE',
    task2: 'toolu_01FFFF',
    agent1: 'toolu_01GGGG',
    bashFail: 'toolu_01HHHH',
  };
  const lines: unknown[] = [];
  const push = (r: unknown) => lines.push(r);
  const asst = (
    uuid: string,
    parentUuid: string,
    content: unknown[],
    stop = 'tool_use',
    model = 'claude-opus-5',
  ) =>
    env({
      type: 'assistant',
      uuid,
      parentUuid,
      timestamp: ts(),
      requestId: `req_${uuid}`,
      message: {
        model,
        id: `msg_${uuid}`,
        type: 'message',
        role: 'assistant',
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 10 },
      },
    });
  const result = (
    uuid: string,
    parentUuid: string,
    toolUseId: string,
    content: unknown,
    isError: boolean,
    toolUseResult: unknown,
    pid = promptId,
  ) =>
    env({
      type: 'user',
      uuid,
      parentUuid,
      timestamp: ts(2),
      promptId: pid,
      message: {
        role: 'user',
        content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }],
      },
      toolUseResult,
      sourceToolAssistantUUID: parentUuid,
    });

  push({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: ts(0),
    sessionId,
    content: 'Fix login session handling',
  });
  push(
    env({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      timestamp: ts(),
      promptId,
      promptSource: 'typed',
      permissionMode: 'default',
      origin: { kind: 'human' },
      message: {
        role: 'user',
        content: 'Fix login session handling so concurrent refreshes do not interfere',
      },
    }),
  );
  push(
    env({
      type: 'attachment',
      uuid: 'att1',
      parentUuid: 'u1',
      timestamp: ts(0),
      attachment: { type: 'skill_listing' },
    }),
  );
  push(
    asst('a1', 'u1', [
      { type: 'thinking', thinking: 'internal', signature: 'x' },
      {
        type: 'text',
        text: 'Investigating the authentication flow to see how refresh is triggered.',
      },
      {
        type: 'tool_use',
        id: ids.bash1,
        name: 'Bash',
        input: { command: 'rg -n "refresh" src/auth', description: 'Find refresh call sites' },
      },
    ]),
  );
  push(
    result(
      'r1',
      'a1',
      ids.bash1,
      'src/auth/AuthMiddleware.ts:12: refresh()\nsrc/auth/SessionManager.ts:40: refresh()',
      false,
      {
        stdout:
          'src/auth/AuthMiddleware.ts:12: refresh()\nsrc/auth/SessionManager.ts:40: refresh()',
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
    ),
  );
  push(
    asst('a2', 'r1', [
      {
        type: 'text',
        text: 'Found duplicate refresh behavior: AuthMiddleware and SessionManager both rotate tokens.',
      },
      {
        type: 'tool_use',
        id: ids.task1,
        name: 'TaskCreate',
        input: {
          subject: 'Move refresh ownership into SessionManager',
          description: 'Single owner for token rotation',
          activeForm: 'Moving refresh ownership',
        },
      },
    ]),
  );
  push(
    result('r2', 'a2', ids.task1, 'Task #1 created successfully', false, {
      task: {
        id: '1',
        subject: 'Move refresh ownership into SessionManager',
        description: 'Single owner for token rotation',
        activeForm: 'Moving refresh ownership',
        status: 'pending',
        blocks: [],
        blockedBy: [],
      },
    }),
  );
  push(
    asst('a3', 'r2', [
      {
        type: 'tool_use',
        id: ids.task2,
        name: 'TaskUpdate',
        input: { taskId: '1', status: 'in_progress' },
      },
    ]),
  );
  push(
    result('r3', 'a3', ids.task2, 'Updated task #1 status', false, {
      taskId: '1',
      statusChange: { from: 'pending', to: 'in_progress' },
      updatedFields: ['status'],
      success: true,
    }),
  );
  push(
    asst('a4', 'r3', [
      {
        type: 'text',
        text: "I'll move refresh ownership into SessionManager and add a mutex around token rotation.",
      },
      {
        type: 'tool_use',
        id: ids.edit1,
        name: 'Edit',
        input: {
          file_path: `${cwd}/src/auth/SessionManager.ts`,
          old_string: 'async refresh() {\n  rotate();\n}',
          new_string:
            'async refresh() {\n  await this.lock.acquire();\n  try { rotate(); } finally { this.lock.release(); }\n}',
        },
      },
    ]),
  );
  push(
    result(
      'r4',
      'a4',
      ids.edit1,
      `The file ${cwd}/src/auth/SessionManager.ts has been updated.`,
      false,
      {
        filePath: `${cwd}/src/auth/SessionManager.ts`,
        oldString: 'async refresh() {\n  rotate();\n}',
        newString:
          'async refresh() {\n  await this.lock.acquire();\n  try { rotate(); } finally { this.lock.release(); }\n}',
        originalFile: 'class SessionManager {\nasync refresh() {\n  rotate();\n}\n}\n',
        structuredPatch: [
          {
            oldStart: 2,
            oldLines: 3,
            newStart: 2,
            newLines: 4,
            lines: [
              ' async refresh() {',
              '-  rotate();',
              '+  await this.lock.acquire();',
              '+  try { rotate(); } finally { this.lock.release(); }',
              ' }',
            ],
          },
        ],
        userModified: false,
        replaceAll: false,
      },
    ),
  );
  push(
    asst('a5', 'r4', [
      {
        type: 'tool_use',
        id: ids.bashFail,
        name: 'Bash',
        input: { command: 'pnpm vitest run', description: 'Run the test suite' },
      },
    ]),
  );
  push(
    result(
      'r5',
      'a5',
      ids.bashFail,
      'Exit code 1\n ❯ src/auth/session.test.ts (45 tests | 3 failed)\n Test Files  1 failed (1)\n      Tests  3 failed | 42 passed (45)',
      true,
      'Error: Exit code 1\n ❯ src/auth/session.test.ts (45 tests | 3 failed)\n Test Files  1 failed (1)\n      Tests  3 failed | 42 passed (45)',
    ),
  );
  push(
    asst('a6', 'r5', [
      { type: 'text', text: 'The mocks are outdated; updating them.' },
      {
        type: 'tool_use',
        id: ids.write1,
        name: 'Write',
        input: {
          file_path: `${cwd}/src/auth/__mocks__/lock.ts`,
          content: 'export const lock = { acquire: async () => {}, release: () => {} };\n',
        },
      },
    ]),
  );
  push(
    result(
      'r6',
      'a6',
      ids.write1,
      `File created successfully at: ${cwd}/src/auth/__mocks__/lock.ts`,
      false,
      {
        type: 'create',
        filePath: `${cwd}/src/auth/__mocks__/lock.ts`,
        content: 'export const lock = { acquire: async () => {}, release: () => {} };\n',
        structuredPatch: [],
        originalFile: null,
        userModified: false,
      },
    ),
  );
  push(
    asst('a7', 'r6', [
      {
        type: 'tool_use',
        id: ids.bash2,
        name: 'Bash',
        input: { command: 'pnpm vitest run', description: 'Re-run the test suite' },
      },
    ]),
  );
  push(
    result('r7', 'a7', ids.bash2, ' Test Files  1 passed (1)\n      Tests  45 passed (45)', false, {
      stdout: ' Test Files  1 passed (1)\n      Tests  45 passed (45)',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    }),
  );
  push(
    asst('a8', 'r7', [
      {
        type: 'tool_use',
        id: ids.agent1,
        name: 'Agent',
        input: {
          description: 'Review the concurrency change',
          subagent_type: 'general-purpose',
          prompt: 'Review SessionManager refresh locking',
        },
      },
    ]),
  );
  push(
    result('r8', 'a8', ids.agent1, 'Async agent launched', false, {
      isAsync: true,
      status: 'async_launched',
      agentId: 'ab12cd34ef56ab78c',
      description: 'Review the concurrency change',
      prompt: 'Review SessionManager refresh locking',
      outputFile: '/tmp/x',
      canReadOutputFile: true,
    }),
  );
  // Real shape: each block of the final message is its own record, all stamped end_turn.
  push(asst('a9a', 'r8', [{ type: 'thinking', thinking: 'wrap up', signature: 'x' }], 'end_turn'));
  push(
    asst(
      'a9',
      'a9a',
      [
        {
          type: 'text',
          text: '## Summary\n\nMoved refresh ownership into SessionManager and added a lock. **45/45 tests pass.**\n\nRemaining: the reviewer subagent is still running.',
        },
      ],
      'end_turn',
    ),
  );
  push({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 's1',
    parentUuid: null,
    logicalParentUuid: 'a9',
    timestamp: ts(),
    sessionId,
    cwd,
    version,
    compactMetadata: { trigger: 'auto', preTokens: 100000, postTokens: 5000 },
  });
  push(
    env({
      type: 'user',
      uuid: 'u2',
      parentUuid: 's1',
      timestamp: ts(),
      promptId: promptId2,
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'Summary of prior work…' },
    }),
  );
  push(
    env({
      type: 'user',
      uuid: 'u3',
      parentUuid: 'u2',
      timestamp: ts(),
      promptId: promptId2,
      promptSource: 'typed',
      message: { role: 'user', content: 'Also add a regression test' },
    }),
  );
  push(asst('a10', 'u3', [{ type: 'text', text: 'Adding a regression test now.' }]));
  push(
    env({
      type: 'user',
      uuid: 'u4',
      parentUuid: 'a10',
      timestamp: ts(),
      promptId: promptId2,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    }),
  );
  push({ type: 'custom-title', customTitle: 'Login session refresh fix', sessionId });
  push({ type: 'unknown-future-record', foo: 1, sessionId });
  return { sessionId, lines: [...lines.map((l) => JSON.stringify(l)), '{not json', ''], ids };
}
