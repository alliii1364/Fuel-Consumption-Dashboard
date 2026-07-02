import type { Metadata, Viewport } from "next";
import RegisterSW from "./RegisterSW";

export const metadata: Metadata = {
  title: "FuelIQ Driver",
  // Make "Add to Home Screen" launch fullscreen (no browser chrome) like a
  // native app. `appleWebApp` emits the iOS tags; `mobile-web-app-capable`
  // covers Android/Chrome. Pairs with manifest `display: standalone`.
  appleWebApp: {
    capable: true,
    title: "FuelIQ Driver",
    statusBarStyle: "black-translucent",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#E84040",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false, // app-like: no pinch/double-tap zoom
};

export default function DriverLayout({ children }: { children: React.ReactNode }) {
  // The global `html, body { overflow: hidden }` (globals.css) stops the page
  // itself from scrolling — the manager dashboard scrolls inside its AppShell
  // panel instead. The driver screens have no such panel, so this wrapper owns
  // the scroll: a full-height (dynamic-viewport) region that scrolls its own
  // overflow, with momentum scrolling on iOS. Safe-area padding keeps content
  // clear of the notch.
  return (
    <div
      className="driver-app"
      style={{
        height: "100dvh",
        overflowY: "auto",
        WebkitOverflowScrolling: "touch",
        background: "#F4F4F6",
        paddingTop: "env(safe-area-inset-top)",
      }}
    >
      <RegisterSW />
      {children}
    </div>
  );
}
