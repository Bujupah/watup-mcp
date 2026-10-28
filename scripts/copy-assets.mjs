// Copies non-TS runtime assets into dist/ after tsc.
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const assets = [['src/db/schema.sql', 'dist/src/db/schema.sql']];
for (const [from, to] of assets) {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
}
for (const bin of ['dist/src/index.js', 'dist/bin/stdio-shim.js']) chmodSync(bin, 0o755);
