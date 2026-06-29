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
  return (
    <div style={{ minHeight: "100vh", background: "#F4F4F6" }}>
      <RegisterSW />
      {children}
    </div>
  );
}
