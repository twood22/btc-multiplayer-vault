#!/usr/bin/env node
import { loadProtectedEnvironmentFile } from './operator-environment.js';

// Configuration modules read their values during import. Load the protected
// operator environment before importing the command implementation so live
// credentials, the non-public proof seed, runtime pins, and committed
// economics all reach the exact same configuration snapshot.
const baseEnvironmentPath = process.env.BTC_VAULT_ENV_FILE || '.env';
const extraEnvironmentPath = process.env.BTC_VAULT_EXTRA_ENV_FILE;
loadProtectedEnvironmentFile(baseEnvironmentPath);
if (extraEnvironmentPath) {
  loadProtectedEnvironmentFile(extraEnvironmentPath, { required: true });
}

await import('./cli-main.js');
