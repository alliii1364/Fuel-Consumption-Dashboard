import type { MetadataRoute } from "next";

// Required so the manifest route can be statically exported (CAP_BUILD).
export const dynamic = "force-static";

// PWA manifest — primarily for the installable driver app (/driver).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FuelIQ Driver",
    short_name: "Driver",
    description: "Fleet dispatch jobs for drivers",
    start_url: "/driver",
    scope: "/driver",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#E84040",
    icons: [
      { src: "/IFS%20Logo.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
    ],
  };
}
