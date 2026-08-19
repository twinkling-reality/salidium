/**
 * Builds a synthetic Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`)
 * with the exact record shapes observed in Codex CLI 0.14x legacy-history rollouts (envelope
 * `{timestamp, type, payload}`, payload keys and nesting), without any real user content.
 *
 * Covers both tool modes in one file so the parser's handling of each can be asserted together:
 * function tools (`exec_command` + `write_stdin`, `update_plan`) and code mode (`exec` cells that
 * call `tools.exec_command(...)`, polled with `wait`).
 */
export interface SyntheticRolloutOptions {
  threadId?: string;
  cwd?: string;
  cliVersion?: string;
  model?: string;
}

export function buildSyntheticRollout(opts: SyntheticRolloutOptions = {}): {
  threadId: string;
  lines: string[];
  ids: Record<string, string>;
} {
  const threadId = opts.threadId ?? '01a00b4a-d527-75c2-bb45-db3d42e773be';
  const cwd = opts.cwd ?? '/repo/app';
  const cliVersion = opts.cliVersion ?? '0.148.0';
  const model = opts.model ?? 'gpt-5.6';
  let t = Date.parse('2026-08-16T15:57:00.000Z');
  const ts = (s = 3) => {
    t += s * 1000;
    return new Date(t).toISOString();
  };
  const epoch = () => Math.floor(t / 1000);

  const turn1 = '01a00b4a-d81e-7863-b9c1-14579373d956';
  const turn2 = '01a00b4c-4a10-7c2e-9d0e-3f2a1b0c9d8e';
  const ids = {
    turn1,
    turn2,
    exec1: 'call_SrpcTXAG4uu0ntf7UArMIn89', // exec_command (function tool), exits 0
    patch1: 'call_q5PVFv3NGaTz2Yk1LmNoPqRs', // apply_patch custom tool + patch_apply_end
    plan1: 'call_u0aKLS7nAbCdEfGhIjKlMnOp', // update_plan
    cell1: 'call_ToGjelLmh9NqRsTuVwXyZaBc', // exec code cell, completes in one shot
    cell2: 'call_wZBMSAzHxArrN9Tgc2DCuHTa', // exec code cell, still running → wait ×2
    wait1: 'call_tK8PdioxaZ2EvTi21aqEYgNV',
    wait2: 'call_9mQvXbLpRt3sWuYzAcEgIkMo',
    exec2: 'call_h7Jk2LmN4pQr6StU8vWx0YzA', // exec_command, still running → write_stdin
    stdin1: 'call_bC3dE5fG7hI9jK1lM3nO5pQ7',
    cell3: 'call_rS9tU1vW3xY5zA7bC9dE1fG3', // exec code cell in turn 2, failed script
  };
  const passthrough = (turnId: string) => ({
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  });
  const lines: unknown[] = [];
  const push = (type: string, payload: unknown, dt?: number) =>
    lines.push({ timestamp: ts(dt), type, payload });
  const inputText = (...texts: string[]) => texts.map((text) => ({ type: 'input_text', text }));

  // ---- session start -----------------------------------------------------------------------
  push(
    'session_meta',
    {
      session_id: threadId,
      id: threadId,
      timestamp: new Date(t).toISOString(),
      cwd,
      originator: 'codex_cli_rs',
      cli_version: cliVersion,
      source: 'cli',
      thread_source: 'user',
      model_provider: 'openai',
      base_instructions: { text: 'You are Codex.' },
      history_mode: 'legacy',
      context_window: { window_id: '01a00b4a-d527-7000-8000-000000000001' },
      git: {
        commit_hash: '3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a',
        branch: 'main',
        repository_url: 'git@example.invalid:acme/app.git',
      },
    },
    0,
  );

  // ---- turn 1 ------------------------------------------------------------------------------
  push('event_msg', {
    type: 'task_started',
    turn_id: turn1,
    started_at: epoch(),
    model_context_window: 258400,
    collaboration_mode_kind: 'default',
  });
  push('turn_context', {
    turn_id: turn1,
    cwd,
    workspace_roots: [cwd],
    current_date: '2026-08-16',
    timezone: 'America/Los_Angeles',
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    sandbox_policy: { type: 'workspace-write' },
    permission_profile: { type: 'default' },
    model,
    comp_hash: 'a1b2c3d4',
    personality: 'default',
    collaboration_mode: { mode: 'default', settings: {} },
    multi_agent_version: 'v2',
  });
  push('event_msg', {
    type: 'user_message',
    client_id: 'ffffffff-0000-4000-8000-000000000001',
    message: 'Fix the flaky retry test and make the suite pass',
    images: [],
    local_images: [],
    audio: [],
    local_audio: [],
    text_elements: [],
  });
  push('response_item', {
    type: 'message',
    id: 'msg_u1',
    role: 'user',
    content: [{ type: 'input_text', text: 'Fix the flaky retry test and make the suite pass' }],
    ...passthrough(turn1),
  });
  push('event_msg', { type: 'agent_reasoning', text: '**Inspecting the retry helper**' });
  push('response_item', {
    type: 'reasoning',
    id: 'rs_1',
    summary: [],
    encrypted_content: 'gAAAAABo…',
    ...passthrough(turn1),
  });
  push('event_msg', {
    type: 'agent_message',
    message: 'Looking at the retry helper first.',
    phase: 'commentary',
    memory_citation: null,
  });
  // Function-tool mode: exec_command with a Chunk ID / Process exited header.
  push('response_item', {
    type: 'function_call',
    id: 'fc_1',
    name: 'exec_command',
    arguments: JSON.stringify({
      cmd: 'rg -n "retry" src/',
      workdir: cwd,
      yield_time_ms: 10000,
      max_output_tokens: 12000,
    }),
    call_id: ids.exec1,
    ...passthrough(turn1),
  });
  push('response_item', {
    type: 'function_call_output',
    id: 'fco_1',
    call_id: ids.exec1,
    output:
      'Chunk ID: 0ee593\nWall time: 0.0123 seconds\nProcess exited with code 0\nOriginal token count: 13\nOutput:\nsrc/retry.ts:12: export function retry()\nsrc/retry.test.ts:4: retry(',
    ...passthrough(turn1),
  });
  // apply_patch: custom_tool_call → patch_apply_end (structured changes) → custom_tool_call_output.
  const patch =
    '*** Begin Patch\n*** Update File: src/retry.ts\n@@\n-  const cap = 3;\n+  const cap = 5;\n+  const jitter = true;\n*** Add File: src/retry.test.ts\n+import { retry } from "./retry";\n+test("retries", () => {});\n*** End Patch';
  push('response_item', {
    type: 'custom_tool_call',
    id: 'ctc_1',
    status: 'completed',
    call_id: ids.patch1,
    name: 'apply_patch',
    input: patch,
    ...passthrough(turn1),
  });
  push('event_msg', {
    type: 'patch_apply_end',
    call_id: ids.patch1,
    turn_id: turn1,
    stdout: 'Success. Updated the following files:\nM src/retry.ts\nA src/retry.test.ts\n',
    stderr: '',
    success: true,
    status: 'completed',
    changes: {
      [`${cwd}/src/retry.ts`]: {
        type: 'update',
        unified_diff:
          '@@ -1,3 +1,4 @@\n export function retry() {\n-  const cap = 3;\n+  const cap = 5;\n+  const jitter = true;\n }',
      },
      [`${cwd}/src/retry.test.ts`]: {
        type: 'add',
        content: 'import { retry } from "./retry";\ntest("retries", () => {});',
      },
    },
  });
  push('response_item', {
    type: 'custom_tool_call_output',
    id: 'ctco_1',
    call_id: ids.patch1,
    output: inputText(
      'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nSuccess. Updated the following files:\nM src/retry.ts\nA src/retry.test.ts\n',
    ),
    ...passthrough(turn1),
  });
  // update_plan (function tool).
  push('response_item', {
    type: 'function_call',
    id: 'fc_2',
    name: 'update_plan',
    arguments: JSON.stringify({
      explanation: 'Reproduced the flake; fixing backoff before re-running.',
      plan: [
        { step: 'Reproduce the flaky test', status: 'completed' },
        { step: 'Fix retry backoff', status: 'in_progress' },
        { step: 'Run the suite', status: 'pending' },
      ],
    }),
    call_id: ids.plan1,
    ...passthrough(turn1),
  });
  push('response_item', {
    type: 'function_call_output',
    id: 'fco_2',
    call_id: ids.plan1,
    output: 'Plan updated',
    ...passthrough(turn1),
  });
  // Code mode: an exec cell that runs the test file and completes within the yield window.
  push('response_item', {
    type: 'custom_tool_call',
    id: 'ctc_2',
    status: 'completed',
    call_id: ids.cell1,
    name: 'exec',
    input:
      'const r = await tools.exec_command({\n  cmd: "pnpm vitest run src/retry.test.ts",\n  workdir: "/repo/app",\n  yield_time_ms: 10000,\n  max_output_tokens: 30000\n});\ntext(r.output);\n',
    ...passthrough(turn1),
  });
  push('response_item', {
    type: 'custom_tool_call_output',
    id: 'ctco_2',
    call_id: ids.cell1,
    output: inputText(
      'Script completed\nWall time 3.1 seconds\nOutput:\n',
      ' ✓ src/retry.test.ts (5 tests) 40ms\n\n Test Files  1 passed (1)\n      Tests  5 passed (5)\n',
    ),
    ...passthrough(turn1),
  });
  // Code mode: a long-running cell (full suite) that yields, is polled twice, then completes.
  push('response_item', {
    type: 'custom_tool_call',
    id: 'ctc_3',
    status: 'completed',
    call_id: ids.cell2,
    name: 'exec',
    input:
      'const r = await tools.exec_command({\n  cmd: "pnpm vitest run",\n  workdir: "/repo/app",\n  yield_time_ms: 10000,\n  max_output_tokens: 20000\n});\ntext(r.output);\n',
    ...passthrough(turn1),
  });
  push(
    'response_item',
    {
      type: 'custom_tool_call_output',
      id: 'ctco_3',
      call_id: ids.cell2,
      output: 'Script running with cell ID 8\nWall time 10.0 seconds\nOutput:\n',
      ...passthrough(turn1),
    },
    10,
  );
  push('response_item', {
    type: 'function_call',
    id: 'fc_3',
    name: 'wait',
    arguments: JSON.stringify({ cell_id: '8', yield_time_ms: 30000, max_tokens: 20000 }),
    call_id: ids.wait1,
    ...passthrough(turn1),
  });
  push(
    'response_item',
    {
      type: 'function_call_output',
      id: 'fco_3',
      call_id: ids.wait1,
      output: 'Script running with cell ID 8\nWall time 30.0 seconds\nOutput:\n',
      ...passthrough(turn1),
    },
    30,
  );
  push('response_item', {
    type: 'function_call',
    id: 'fc_4',
    name: 'wait',
    arguments: JSON.stringify({ cell_id: '8', yield_time_ms: 30000, max_tokens: 20000 }),
    call_id: ids.wait2,
    ...passthrough(turn1),
  });
  push(
    'response_item',
    {
      type: 'function_call_output',
      id: 'fco_4',
      call_id: ids.wait2,
      output: inputText(
        'Script completed\nWall time 12.3 seconds\nOutput:\n',
        ' Test Files  3 passed (3)\n      Tests  45 passed (45)\n',
      ),
      ...passthrough(turn1),
    },
    12,
  );
  // Function-tool mode: exec_command that yields with a session id; write_stdin returns the exit.
  push('response_item', {
    type: 'function_call',
    id: 'fc_5',
    name: 'exec_command',
    arguments: JSON.stringify({
      cmd: 'pnpm tsc --build',
      workdir: cwd,
      yield_time_ms: 10000,
      max_output_tokens: 12000,
    }),
    call_id: ids.exec2,
    ...passthrough(turn1),
  });
  push(
    'response_item',
    {
      type: 'function_call_output',
      id: 'fco_5',
      call_id: ids.exec2,
      output:
        'Chunk ID: 9893d2\nWall time: 10.0089 seconds\nProcess running with session ID 64896\nOriginal token count: 37\nOutput:\n',
      ...passthrough(turn1),
    },
    10,
  );
  push('response_item', {
    type: 'function_call',
    id: 'fc_6',
    name: 'write_stdin',
    arguments: JSON.stringify({
      session_id: 64896,
      chars: '',
      yield_time_ms: 30000,
      max_output_tokens: 12000,
    }),
    call_id: ids.stdin1,
    ...passthrough(turn1),
  });
  push(
    'response_item',
    {
      type: 'function_call_output',
      id: 'fco_6',
      call_id: ids.stdin1,
      output:
        "Chunk ID: e5e117\nWall time: 22.2945 seconds\nProcess exited with code 2\nOriginal token count: 156\nOutput:\nsrc/retry.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
      ...passthrough(turn1),
    },
    22,
  );
  push('event_msg', {
    type: 'agent_message',
    message: 'Fixed the retry backoff. 45/45 tests pass; the tsc error is a pre-existing typo.',
    phase: 'final_answer',
    memory_citation: null,
  });
  push('event_msg', {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: 12000,
        cached_input_tokens: 8000,
        cache_write_input_tokens: 0,
        output_tokens: 900,
        reasoning_output_tokens: 300,
        total_tokens: 12900,
      },
      last_token_usage: {
        input_tokens: 1200,
        cached_input_tokens: 800,
        cache_write_input_tokens: 0,
        output_tokens: 90,
        reasoning_output_tokens: 30,
        total_tokens: 1290,
      },
      model_context_window: 258400,
    },
    rate_limits: null,
  });
  push('event_msg', {
    type: 'task_complete',
    turn_id: turn1,
    last_agent_message:
      'Fixed the retry backoff. 45/45 tests pass; the tsc error is a pre-existing typo.',
    started_at: epoch() - 120,
    completed_at: epoch(),
    duration_ms: 120000,
    time_to_first_token_ms: 900,
  });

  // ---- turn 2 (steered mid-turn, compacted, interrupted) -----------------------------------
  push('event_msg', {
    type: 'task_started',
    turn_id: turn2,
    started_at: epoch(),
    model_context_window: 258400,
    collaboration_mode_kind: 'default',
  });
  push('turn_context', {
    turn_id: turn2,
    cwd,
    workspace_roots: [cwd],
    current_date: '2026-08-16',
    timezone: 'America/Los_Angeles',
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    sandbox_policy: { type: 'workspace-write' },
    permission_profile: { type: 'default' },
    model,
    comp_hash: 'a1b2c3d4',
    personality: 'default',
    collaboration_mode: { mode: 'default', settings: {} },
    multi_agent_version: 'v2',
  });
  push('event_msg', {
    type: 'user_message',
    client_id: 'ffffffff-0000-4000-8000-000000000002',
    message: 'Also add a regression test for the timeout path',
    images: [],
    local_images: [],
    audio: [],
    local_audio: [],
    text_elements: [],
  });
  push('event_msg', {
    type: 'agent_message',
    message: 'Adding a timeout regression test.',
    phase: 'commentary',
    memory_citation: null,
  });
  // A second user message inside the same turn (queued/steering input; no new task_started).
  push('event_msg', {
    type: 'user_message',
    client_id: 'ffffffff-0000-4000-8000-000000000003',
    message: 'And keep the retry cap at 5',
    images: [],
    local_images: [],
    audio: [],
    local_audio: [],
    text_elements: [],
  });
  push('event_msg', { type: 'context_compacted' });
  push('event_msg', {
    type: 'thread_settings_applied',
    thread_settings: { model, approval_policy: 'on-request', cwd },
  });
  push('response_item', {
    type: 'custom_tool_call',
    id: 'ctc_4',
    status: 'completed',
    call_id: ids.cell3,
    name: 'exec',
    input:
      'const r = await tools.exec_command({\n  cmd: "pnpm vitest run src/timeout.test.ts",\n  workdir: "/repo/app",\n  yield_time_ms: 10000,\n  max_output_tokens: 30000\n});\ntext(r.output);\n',
    ...passthrough(turn2),
  });
  push('response_item', {
    type: 'custom_tool_call_output',
    id: 'ctco_4',
    call_id: ids.cell3,
    output: inputText(
      'Script failed\nWall time 0.1 seconds\nOutput:\n',
      'Script error:\nexec_command failed for `/bin/zsh -lc "pnpm vitest run src/timeout.test.ts"`: CreateProcess { message: "Rejected" }',
    ),
    ...passthrough(turn2),
  });
  push('event_msg', {
    type: 'turn_aborted',
    turn_id: turn2,
    reason: 'interrupted',
    started_at: epoch() - 20,
    completed_at: epoch(),
    duration_ms: 20000,
  });
  // Records the parser does not model (host prompt state) and a future record type.
  push('world_state', {
    full: true,
    state: { agents_md: {}, permissions: 'workspace-write', skills: {} },
  });
  push('unknown-future-record', { foo: 1 });

  return {
    threadId,
    lines: [...lines.map((l) => JSON.stringify(l)), '{not json', ''],
    ids,
  };
}
