import './check-runtime.mjs';
import { assertBuildNetwork } from './check-build-network.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assertBuildNetwork();
await import(pathToFileURL(resolve(process.cwd(), 'server.js')).href);
