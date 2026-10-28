import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// patches/baileys+*.patch must be applied (postinstall: patch-package). Without it Baileys
// crashes acking notifications that arrive before pairing completes, and linking fails on the phone.
describe('baileys patch', () => {
  it('acks notifications before creds.me exists', () => {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve('baileys/package.json'));
    const src = readFileSync(join(root, 'lib/Socket/messages-recv.js'), 'utf8');
    expect(src).toContain('buildAckStanza(node, errorCode, authState.creds.me?.id)');
  });
});
