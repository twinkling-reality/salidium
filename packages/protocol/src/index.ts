/**
 * @salidium/protocol — schemas and types shared by every Salidium package.
 * Contains no I/O and no logic beyond schema definitions and id composition.
 */
export const PROTOCOL_VERSION = '1';

export * from './changes.ts';
export * from './events.ts';
export * from './ids.ts';
export * from './provenance.ts';
export * from './timestamps.ts';
export * from './wire.ts';
