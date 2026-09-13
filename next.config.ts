import type { NextConfig } from "next";

/**
 * The orchestrator core is ESM TypeScript that imports with explicit `.js`
 * specifiers (required by Node's ESM resolver). Bundlers do not resolve those to
 * `.ts` by default, so the extension is aliased here.
 *
 * `serverExternalPackages` keeps `pg` out of the bundle: it is a native-ish
 * driver that must be required at runtime, not bundled.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
