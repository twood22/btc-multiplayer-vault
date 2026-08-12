import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  typescript: { tsconfigPath: './tsconfig.web.json' },
  // The authoritative vault core is Node ESM and correctly spells its local
  // imports with .js extensions. During the web build those imports point at
  // TypeScript source, so Webpack must apply the standard TS ESM extension
  // alias instead of forcing a second, divergent browser wallet model.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.js'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
};

export default nextConfig;
