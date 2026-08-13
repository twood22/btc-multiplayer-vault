import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  output: 'standalone',
  // Keep repository instructions deliberate. `next dev` otherwise writes
  // generated AGENTS.md and CLAUDE.md files into the worktree.
  agentRules: false,
  poweredByHeader: false,
  typescript: { tsconfigPath: './tsconfig.web.json' },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
      ],
    }];
  },
  // The authoritative vault core is Node ESM and correctly spells its local
  // imports with .js extensions. During the web build those imports point at
  // TypeScript source, so Webpack must apply the standard TS ESM extension
  // alias instead of forcing a second, divergent browser wallet model.
  webpack(config, { isServer, webpack }) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    if (!isServer) {
      config.experiments = {
        ...(config.experiments || {}),
        asyncWebAssembly: true,
      };
      config.output.environment = {
        ...(config.output.environment || {}),
        asyncFunction: true,
      };
      config.module.rules.push({
        test: /secp256k1\.wasm$/u,
        type: 'webassembly/async',
      });
      const unavailableNodeModule = path.resolve(
        process.cwd(),
        'web/lib/client/sigbash-node-crypto-shim.ts',
      );
      config.resolve.alias = {
        ...(config.resolve.alias || {}),
        crypto: unavailableNodeModule,
        'fs/promises': unavailableNodeModule,
        path: unavailableNodeModule,
        module: unavailableNodeModule,
        worker_threads: unavailableNodeModule,
        'node:fs/promises': unavailableNodeModule,
        'node:path': unavailableNodeModule,
      };
      config.plugins.push(new webpack.NormalModuleReplacementPlugin(
        /^node:(?:fs\/promises|path)$/u,
        unavailableNodeModule,
      ));
    }
    return config;
  },
};

export default nextConfig;
