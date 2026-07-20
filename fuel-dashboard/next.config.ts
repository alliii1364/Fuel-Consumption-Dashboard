import type { NextConfig } from "next";

// CAP_BUILD=1 produces a fully static export (out/) for bundling the driver
// app inside the Capacitor Android shell (offline-capable). The normal dev /
// server build is unaffected.
const isCapBuild = process.env.CAP_BUILD === "1";

const nextConfig: NextConfig = {
  // xlsx is a CommonJS package whose non-standard exports crash Turbopack.
  // Listing it here forces Next.js to transpile it before bundling.
  transpilePackages: ["xlsx"],
  // Allow the dev server's HMR websocket / _next resources when the app is
  // opened over the LAN (e.g. the driver PWA on a phone at
  // http://<lan-ip>:3001). Without this, Next blocks the cross-origin
  // /_next/webpack-hmr socket, the dev client never finishes hydrating, and
  // the page is stuck on its loading spinner. Dev-only; ignored in the
  // Capacitor static export. Wildcards cover a DHCP-changed LAN IP.
  allowedDevOrigins: ["192.168.21.18", "192.168.21.*", "192.168.*.*", "localhost"],
  ...(isCapBuild
    ? {
        output: "export" as const,
        images: { unoptimized: true },
      }
    : {}),
};

export default nextConfig;
