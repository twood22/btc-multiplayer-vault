import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

// No remote code, runtime chunks, Node secrets, or source maps are emitted.
// tiny-secp256k1's exact installed WASM is embedded as bytes, not fetched.
const result = await build({ entryPoints: ['offline/recovery.ts'], bundle: true, write: false,
  format: 'iife', platform: 'browser', target: ['es2022'], minify: true, sourcemap: false,
  legalComments: 'inline', metafile: true, loader: { '.wasm': 'binary' },
  plugins: [{ name: 'embedded-secp256k1-wasm', setup(builder) {
    builder.onLoad({ filter: /[/\\]tiny-secp256k1[/\\]lib[/\\]wasm_loader(?:\.browser)?\.js$/ }, args => ({
      resolveDir: dirname(args.path), loader: 'js', contents: `
        import binary from './secp256k1.wasm';
        import * as rand from './rand.browser.js';
        import * as validateError from './validate_error.js';
        export default new WebAssembly.Instance(new WebAssembly.Module(binary),
          { './rand.js': rand, './validate_error.js': validateError }).exports;
      `,
    }));
  } }],
});
if (result.outputFiles.length !== 1 || Object.values(result.metafile.outputs).some(output => output.imports.length))
  throw new Error('offline utility must have exactly one self-contained output with no external imports');
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const style = readFileSync('offline/recovery.css', 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
const policyHash = value => createHash('sha256').update(value).digest('base64');
const csp = `default-src 'none'; script-src 'sha256-${policyHash(script)}' 'wasm-unsafe-eval'; style-src 'sha256-${policyHash(style)}'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'`;
// A callback preserves literal $&, $` and $' bytes in bundled JavaScript.
// String-replacement interpolation would change both executable code and CSP.
const html = readFileSync('offline/recovery.html', 'utf8').replace('__CSP__', () => csp)
  .replace('__STYLE__', () => style).replace('__SCRIPT__', () => script);
const inputs = Object.keys(result.metafile.inputs).map(path => {
  const safePath = relative(process.cwd(), resolve(path));
  if (safePath.startsWith('..') || safePath.startsWith('/')) throw new Error('offline dependency is outside the repository');
  return { path: safePath, sha256: hash(readFileSync(path)) };
});
for (const path of ['offline/recovery.html','offline/recovery.css','scripts/build-presigned-offline.mjs','package-lock.json'])
  inputs.push({ path, sha256: hash(readFileSync(path)) });
inputs.sort((a, b) => a.path.localeCompare(b.path));
const manifest = { version: 2, protocol: 'presigned-graph-v2', format: 'presigned-offline-utility-v1',
  artifact: 'presigned-recovery.html', sha256: hash(html), inputDigest: hash(JSON.stringify(inputs)),
  byteLength: Buffer.byteLength(html), networkRequests: false, persistentSecretStorage: false, inputs };
mkdirSync('public/offline', { recursive: true });
writeFileSync('public/offline/presigned-recovery.html', html, { mode: 0o644 });
writeFileSync('public/offline/presigned-recovery.manifest.json', `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
console.log(JSON.stringify({ artifact: manifest.artifact, sha256: manifest.sha256, bytes: manifest.byteLength, networkRequests: false }));
