import { readFileSync } from 'node:fs';

function findVersion(): string {
  // Works from both src/ (tsx, vitest) and dist/src/ (compiled).
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkg = JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'whatsapp-mcp' && pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return '0.0.0';
}

export const VERSION = findVersion();
