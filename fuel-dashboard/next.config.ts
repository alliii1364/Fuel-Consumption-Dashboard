import type { NextConfig } from "next";

// CAP_BUILD=1 produces a fully static export (out/) for bundling the driver
// app inside the Capacitor Android shell (offline-capable). The normal dev /
// server build is unaffected.
const isCapBuild = process.env.CAP_BUILD === "1";

const nextConfig: NextConfig = {
  // xlsx is a CommonJS package whose non-standard exports crash Turbopack.
  // Listing it here forces Next.js to transpile it before bundling.
  transpilePackages: ["xlsx"],
  ...(isCapBuild
    ? {
        output: "export" as const,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
