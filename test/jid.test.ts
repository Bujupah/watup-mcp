import { describe, expect, it } from 'vitest';
import { JidError, displayJid, normalizeJid, normalizePhone, parseRecipient, phoneFromJid, toUserJid } from '../src/whatsapp/jid.js';

describe('normalizePhone', () => {
  it.each([
    ['+1 (415) 555-0123', '14155550123'],
    ['+44 7700 900123', '447700900123'],
    ['0044 7700 900123', '447700900123'],
    ['216.98.123.456', '21698123456'],
    ['14155550123', '14155550123'],
  ])('%s -> %s', (input, out) => expect(normalizePhone(input)).toBe(out));

  it.each(['', 'abc', '+123', '+1234567890123456', '07700 900123', '+1 555 CALL'])('rejects %j', (input) => {
    expect(() => normalizePhone(input)).toThrow(JidError);
  });
});

describe('jid helpers', () => {
  it('builds user JIDs', () => expect(toUserJid('+1 415 555 0123')).toBe('14155550123@s.whatsapp.net'));

  it('normalizes raw JIDs', () => {
    expect(normalizeJid('14155550123:12@s.whatsapp.net')).toBe('14155550123@s.whatsapp.net');
    expect(normalizeJid('120363012345678901@g.us')).toBe('120363012345678901@g.us');
    expect(normalizeJid('1234567890-1600000000@g.us')).toBe('1234567890-1600000000@g.us');
    expect(normalizeJid('123456789012345@lid')).toBe('123456789012345@lid');
    expect(() => normalizeJid('foo@bar.com')).toThrow(JidError);
    expect(() => normalizeJid('abc@s.whatsapp.net')).toThrow(JidError);
  });

  it('parses recipients', () => {
    expect(parseRecipient('+1 415 555 0123')).toEqual({ kind: 'phone', digits: '14155550123', jid: '14155550123@s.whatsapp.net' });
    expect(parseRecipient('120363012345678901@g.us')).toEqual({ kind: 'jid', jid: '120363012345678901@g.us' });
    expect(parseRecipient('Mom')).toEqual({ kind: 'name', name: 'Mom' });
    expect(parseRecipient('Agent 007')).toEqual({ kind: 'name', name: 'Agent 007' });
    expect(() => parseRecipient('  ')).toThrow(JidError);
  });

  it('extracts phones', () => {
    expect(phoneFromJid('14155550123:3@s.whatsapp.net')).toBe('14155550123');
    expect(phoneFromJid('123@lid')).toBeUndefined();
    expect(displayJid('14155550123@s.whatsapp.net')).toBe('+14155550123');
  });
});
