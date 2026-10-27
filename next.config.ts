import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: ["dockerode"],
  // Dynamic source snapshots make Turbopack trace the project root. Keep
  // local persistence, credentials, and operator-only docs/tools out of any
  // route trace while retaining src/ and the runtime package/config files.
  outputFileTracingExcludes: {
    "/*": [
      "./.data/**", "./.env", "./.env.*", "./**/.env", "./**/.env.*",
      "./**/*.pem", "./**/*.key", "./**/*.p12", "./**/*.pfx",
      "./AGENTS.md", "./IMPLEMENTATION_PLAN.md", "./README.md", "./SECURITY.md", "./WORKLOG.md",
      "./sandbox/**", "./tsconfig.tsbuildinfo",
    ],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
