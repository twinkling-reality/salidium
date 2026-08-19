/** What to do with an event sequence received from a reconnectable session stream. */
export function classifyStreamSequence(
  expected: number,
  received: number,
): 'accept' | 'duplicate' | 'resnapshot' {
  if (received < expected) return 'duplicate';
  if (received > expected) return 'resnapshot';
  return 'accept';
}
