import type { CanonicalEvent, ToolInput } from '@salidium/protocol';
import type { Redactor } from './redactText.ts';
import {
  isCredentialDumpCommand,
  isSensitiveMcpFileRead,
  isSensitivePath,
} from './sensitivePaths.ts';

const SUPPRESSED = '[contents suppressed: sensitive file or credential dump]';

export interface RedactionContext {
  /** Resolves the command string for a call id (tool.completed does not carry it). */
  commandForCall?: (callId: string) => string | undefined;
  /** Resolves the original input when a generic result needs call-aware structural suppression. */
  inputForCall?: (callId: string) => ToolInput | undefined;
}

/**
 * Applies redaction to every free-text field of an event, and structural suppression to reads
 * or dumps of sensitive files. Returns the (possibly new) event and the number of findings.
 * Never modifies the caller's object.
 */
export function redactEvent(
  event: CanonicalEvent,
  redactor: Redactor,
  context: RedactionContext = {},
): { event: CanonicalEvent; findings: number } {
  let findings = 0;
  const r = (s: string): string => {
    const out = redactor.redact(s);
    findings += out.findings.length;
    return out.text;
  };
  const opt = (s: string | undefined): string | undefined => (s === undefined ? undefined : r(s));

  switch (event.kind) {
    case 'turn.started':
      return { event: { ...event, prompt: r(event.prompt) }, findings };
    case 'turn.ended':
      return {
        event: { ...event, lastMessage: opt(event.lastMessage), error: opt(event.error) },
        findings,
      };
    case 'agent.message':
      return { event: { ...event, text: r(event.text) }, findings };
    case 'tool.called': {
      const input = event.input;
      const title = r(event.title);
      switch (input.kind) {
        case 'command':
          return {
            event: {
              ...event,
              title,
              input: { ...input, command: r(input.command), description: opt(input.description) },
            },
            findings,
          };
        case 'mcp':
          return {
            event: { ...event, title, input: { ...input, argsExcerpt: opt(input.argsExcerpt) } },
            findings,
          };
        case 'question':
          return {
            event: { ...event, title, input: { ...input, questions: input.questions.map(r) } },
            findings,
          };
        case 'webFetch':
        case 'webSearch':
          return {
            event: { ...event, title, input: { ...input, target: r(input.target) } },
            findings,
          };
        case 'search':
          return {
            event: { ...event, title, input: { ...input, query: r(input.query) } },
            findings,
          };
        case 'subagent':
          return {
            event: { ...event, title, input: { ...input, description: opt(input.description) } },
            findings,
          };
        default:
          return { event: { ...event, title }, findings };
      }
    }
    case 'tool.completed': {
      const result = event.result;
      switch (result.kind) {
        case 'command': {
          const command = context.commandForCall?.(event.callId);
          const dump = command !== undefined && isCredentialDumpCommand(command);
          const outputExcerpt = dump ? SUPPRESSED : r(result.outputExcerpt);
          return { event: { ...event, result: { ...result, outputExcerpt } }, findings };
        }
        case 'fileChanges':
          return {
            event: {
              ...event,
              result: {
                ...result,
                changes: result.changes.map((c) =>
                  isSensitivePath(c.path)
                    ? { ...c, hunks: undefined }
                    : c.hunks
                      ? { ...c, hunks: c.hunks.map((h) => ({ ...h, lines: h.lines.map(r) })) }
                      : c,
                ),
              },
            },
            findings,
          };
        case 'fileRead':
          return {
            event: {
              ...event,
              result: { ...result, suppressed: result.suppressed || isSensitivePath(result.path) },
            },
            findings,
          };
        case 'subagent':
          return {
            event: { ...event, result: { ...result, summaryExcerpt: opt(result.summaryExcerpt) } },
            findings,
          };
        case 'generic': {
          const input = context.inputForCall?.(event.callId);
          if (input?.kind === 'mcp' && isSensitiveMcpFileRead(input)) {
            return {
              event: { ...event, result: { ...result, excerpt: SUPPRESSED } },
              findings,
            };
          }
          return {
            event: { ...event, result: { ...result, excerpt: opt(result.excerpt) } },
            findings,
          };
        }
        default:
          return { event, findings };
      }
    }
    case 'tool.failed':
      return { event: { ...event, errorExcerpt: r(event.errorExcerpt) }, findings };
    case 'subagent.started':
      return { event: { ...event, description: opt(event.description) }, findings };
    case 'subagent.ended':
      return { event: { ...event, lastMessage: opt(event.lastMessage) }, findings };
    case 'plan.updated':
      return {
        event: {
          ...event,
          items: event.items.map((i) => ({ ...i, text: r(i.text), activeForm: opt(i.activeForm) })),
          explanation: opt(event.explanation),
        },
        findings,
      };
    case 'session.started':
      return { event: { ...event, title: opt(event.title) }, findings };
    case 'session.updated':
      return { event: { ...event, title: opt(event.title) }, findings };
    case 'compaction':
      return { event: { ...event, summaryExcerpt: opt(event.summaryExcerpt) }, findings };
    case 'permission.requested':
      return { event: { ...event, summary: r(event.summary) }, findings };
    case 'notification':
      return { event: { ...event, message: r(event.message) }, findings };
    case 'salidium.explanation':
      return {
        event: {
          ...event,
          model: r(event.model),
          what: {
            summary: r(event.what.summary),
            currently: event.what.currently === null ? null : r(event.what.currently),
          },
          why: {
            summary: r(event.why.summary),
            lanes: event.why.lanes.map((lane) => ({
              title: r(lane.title),
              steps: lane.steps.map(r),
            })),
            chain: event.why.chain.map(r),
          },
          how: {
            summary: r(event.how.summary),
            root: event.how.root === null ? null : r(event.how.root),
            steps: event.how.steps.map(r),
          },
          approachChange:
            event.approachChange === null
              ? null
              : {
                  from: r(event.approachChange.from),
                  fromSteps: event.approachChange.fromSteps.map(r),
                  why: r(event.approachChange.why),
                  to: r(event.approachChange.to),
                  toSteps: event.approachChange.toSteps.map(r),
                },
        },
        findings,
      };
    default:
      return { event, findings };
  }
}
