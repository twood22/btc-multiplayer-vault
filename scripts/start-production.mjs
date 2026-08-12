import './check-runtime.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

await import(pathToFileURL(resolve(process.cwd(), 'server.js')).href);
