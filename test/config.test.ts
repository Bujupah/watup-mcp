import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

const KEY = Buffer.alloc(32, 7).toString('base64');
const base = { WA_MCP_TOKEN: 'x'.repeat(20), WA_MCP_MASTER_KEY: KEY };

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ ...base });
    expect(c).toMatchObject({ port: 8787, host: '127.0.0.1', requireConfirm: true, allowlist: [], ratePerMin: 10, newContactsPerDay: 20, logLevel: 'info' });
    expect(c.masterKey.length).toBe(32);
    expect(c.dbPath).toMatch(/\.whatsapp-mcp\/data\.db$/);
  });

  it('parses values', () => {
    const c = loadConfig({ ...base, WA_MCP_PORT: '9000', WA_MCP_REQUIRE_CONFIRM: 'false', WA_MCP_ALLOWLIST: ' +1 415 555 0123 , 120363@g.us ,', WA_MCP_RATE_PER_MIN: '3' });
    expect(c).toMatchObject({ port: 9000, requireConfirm: false, allowlist: ['+1 415 555 0123', '120363@g.us'], ratePerMin: 3 });
  });

  it('flags a missing master key specially', () => {
    try {
      loadConfig({ WA_MCP_TOKEN: 'x'.repeat(20) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).missingMasterKey).toBe(true);
    }
  });

  it('rejects bad input', () => {
    expect(() => loadConfig({ ...base, WA_MCP_MASTER_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
    expect(() => loadConfig({ WA_MCP_MASTER_KEY: KEY })).toThrow(/WA_MCP_TOKEN/);
    expect(() => loadConfig({ ...base, WA_MCP_TOKEN: 'short' })).toThrow(/16/);
    expect(() => loadConfig({ ...base, WA_MCP_PORT: 'abc' })).toThrow(/WA_MCP_PORT/);
    expect(() => loadConfig({ ...base, WA_MCP_REQUIRE_CONFIRM: 'maybe' })).toThrow(/boolean/);
  });

  it('refuses remote binding without opt-in', () => {
    expect(() => loadConfig({ ...base, WA_MCP_HOST: '0.0.0.0' })).toThrow(/WA_MCP_ALLOW_REMOTE/);
    expect(loadConfig({ ...base, WA_MCP_HOST: '0.0.0.0', WA_MCP_ALLOW_REMOTE: 'true' }).host).toBe('0.0.0.0');
  });
});
