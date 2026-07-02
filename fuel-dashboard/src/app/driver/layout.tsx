import type { Metadata, Viewport } from "next";
import RegisterSW from "./RegisterSW";

export const metadata: Metadata = {
  title: "FuelIQ Driver",
};

export const viewport: Viewport = {
  themeColor: "#E84040",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
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
