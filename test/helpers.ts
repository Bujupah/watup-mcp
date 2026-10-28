import { randomBytes } from 'node:crypto';
import pino from 'pino';
import { openDatabase, type DB } from '../src/db/db.js';

export const testKey = (): Buffer => randomBytes(32);
export const memDb = (): DB => openDatabase(':memory:');
export const silentLogger = pino({ level: 'silent' });
