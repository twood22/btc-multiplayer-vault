import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  typescript: { tsconfigPath: './tsconfig.web.json' },
};

export default nextConfig;
