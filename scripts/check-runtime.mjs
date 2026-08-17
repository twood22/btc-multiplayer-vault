import { readFileSync } from 'node:fs';

const expected = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim();
const actual = process.versions.node;

if (actual !== expected) {
  throw new Error(
    `btc-multiplayer-vault requires the reviewed Node.js ${expected} runtime; ` +
    `current runtime is ${actual}. Select the repository's .node-version before continuing.`,
  );
}
