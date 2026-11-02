import type { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { type RunState, reviveState } from '@salidium/core';
import type { CanonicalEvent, StoredEvent } from '@salidium/protocol';

const CHECKPOINT_GZIP_PREFIX = 'gzip-base64:v1:';
const CHECKPOINT_COMPRESS_MIN_BYTES = 4 * 1024;
const CHECKPOINT_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const CHECKPOINT_GZIP_MAGIC = Buffer.from('SCP1');
const EVENT_GZIP_MAGIC = Buffer.from('SEV1');
export const EVENT_COMPRESS_MIN_BYTES = 1024;
const EVENT_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;
export const OPTIMIZED_STORE_PAGE_SIZE = 16 * 1024;
export const STORAGE_LAYOUT_VERSION = 1;
export const MAX_RAW_FINGERPRINT_CONFLICTS = 10_000;

export type EncodedJson = string | Uint8Array;

export function canonicalizeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

export function comparableEvent(event: CanonicalEvent | StoredEvent): unknown {
  const copy = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  delete copy.seq;
  delete copy.redactions;
  const source = copy.source as Record<string, unknown> | undefined;
  const ref = source?.ref as Record<string, unknown> | undefined;
  if (ref) delete ref.recordHash;
  return copy;
}

function hasMagic(buffer: Buffer, magic: Buffer): boolean {
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic);
}

function decodeBinaryJson(encoded: EncodedJson, magic: Buffer, maxOutputLength: number): string {
  if (typeof encoded === 'string') return encoded;
  const buffer = Buffer.from(encoded);
  if (!hasMagic(buffer, magic)) return buffer.toString('utf8');
  return gunzipSync(buffer.subarray(magic.length), { maxOutputLength }).toString('utf8');
}

export function encodeEventJson(value: string | StoredEvent): Buffer {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const bytes = Buffer.from(json);
  if (bytes.length < EVENT_COMPRESS_MIN_BYTES) return bytes;
  return Buffer.concat([EVENT_GZIP_MAGIC, gzipSync(bytes, { level: 1 })]);
}

export function decodeEventJson(encoded: EncodedJson): StoredEvent {
  return JSON.parse(decodeEventJsonValue(encoded)) as StoredEvent;
}

export function decodeEventJsonValue(encoded: EncodedJson): string {
  return decodeBinaryJson(encoded, EVENT_GZIP_MAGIC, EVENT_MAX_DECOMPRESSED_BYTES);
}

export function decodeCheckpointValue(encoded: EncodedJson): string {
  if (typeof encoded === 'string' && encoded.startsWith(CHECKPOINT_GZIP_PREFIX)) {
    const compressed = Buffer.from(encoded.slice(CHECKPOINT_GZIP_PREFIX.length), 'base64');
    return gunzipSync(compressed, {
      maxOutputLength: CHECKPOINT_MAX_DECOMPRESSED_BYTES,
    }).toString('utf8');
  }
  return decodeBinaryJson(encoded, CHECKPOINT_GZIP_MAGIC, CHECKPOINT_MAX_DECOMPRESSED_BYTES);
}

export function registerEventDecoder(db: DatabaseSync): void {
  db.function('salidium_event_json', { deterministic: true }, (value) => {
    if (typeof value !== 'string' && !(value instanceof Uint8Array))
      throw new Error('event JSON has an unsupported SQLite value type');
    return decodeBinaryJson(value, EVENT_GZIP_MAGIC, EVENT_MAX_DECOMPRESSED_BYTES);
  });
}

export function encodeCheckpointValue(encoded: EncodedJson): Buffer {
  if (typeof encoded === 'string' && encoded.startsWith(CHECKPOINT_GZIP_PREFIX))
    return Buffer.concat([
      CHECKPOINT_GZIP_MAGIC,
      Buffer.from(encoded.slice(CHECKPOINT_GZIP_PREFIX.length), 'base64'),
    ]);
  const json = decodeBinaryJson(encoded, CHECKPOINT_GZIP_MAGIC, CHECKPOINT_MAX_DECOMPRESSED_BYTES);
  const bytes = Buffer.from(json);
  if (bytes.length < CHECKPOINT_COMPRESS_MIN_BYTES) return bytes;
  return Buffer.concat([CHECKPOINT_GZIP_MAGIC, gzipSync(bytes, { level: 1 })]);
}

export function encodeCheckpoint(state: RunState): Buffer {
  return encodeCheckpointValue(JSON.stringify(state));
}

export function decodeCheckpoint(encoded: EncodedJson): RunState {
  return reviveState(JSON.parse(decodeCheckpointValue(encoded)) as RunState);
}
