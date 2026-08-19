/**
 * @salidium/core — pure derivation of semantic state from canonical events.
 * No I/O, no DOM, no Node APIs: runs identically in the daemon, the browser, and tests.
 */

export type {
  Classification,
  Confidence,
  ExtractedClaim,
} from './claims/classifyAgentMessage.ts';
export {
  CLAIM_THRESHOLD,
  classifyAgentMessage,
  classifySegment,
  extractClaims,
  headlineOf,
  isAsserted,
  looksLikeTask,
} from './claims/classifyAgentMessage.ts';
export { markdownShape, plainText } from './claims/markdown.ts';
export { cloneState, replayEvents } from './history/replay.ts';
export * from './projections/projectSession.ts';
export {
  effectiveStatus,
  summarizeSession,
  WORKING_STALE_MS,
} from './projections/summarizeSession.ts';
export type { RedactionContext } from './redaction/redactEvent.ts';
export { redactEvent } from './redaction/redactEvent.ts';
export type { RedactionFinding, RedactionResult, Redactor } from './redaction/redactText.ts';
export { createRedactor, shannonEntropy } from './redaction/redactText.ts';
export {
  isCredentialDumpCommand,
  isSensitiveMcpFileRead,
  isSensitivePath,
} from './redaction/sensitivePaths.ts';
export { basename, clip, shortSha } from './state/changeLog.ts';
export { createInitialState, REDUCER_VERSION } from './state/createInitialState.ts';
export { deriveStatus } from './state/deriveStatus.ts';
export { applyEvent, describeVerification } from './state/reducer.ts';
export * from './state/runState.ts';
export {
  classifyCommand,
  detectDestructiveCommand,
  detectGitCommand,
} from './verification/classifyCommand.ts';
export { deriveVerification } from './verification/deriveVerification.ts';
export { parseRunnerOutput, stripAnsi } from './verification/parseRunnerOutput.ts';
