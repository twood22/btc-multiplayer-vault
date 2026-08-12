import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  typescript: { tsconfigPath: './tsconfig.web.json' },
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
