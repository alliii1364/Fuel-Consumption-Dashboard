"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import Sidebar from "./Sidebar";

interface AppShellProps {
  children: React.ReactNode;
  /** Optional right-hand panel (rendered after the main column; hide it
      yourself below `xl` with `hidden xl:flex` for responsive behavior). */
  rightPanel?: React.ReactNode;
}

/**
 * Unified application shell: responsive sidebar (collapsible on desktop,
 * off-canvas drawer on mobile) + main content column + optional right panel.
 * Owns the consistent app background so individual pages don't each invent one.
 */
export default function AppShell({ children, rightPanel }: AppShellProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bg-app flex h-screen overflow-hidden">
      <Sidebar
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onCloseMobile={() => setMobileOpen(false)}
        onToggleCollapse={() => setCollapsed(c => !c)}
      />

      {/* Mobile backdrop */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-black/30 lg:hidden"
          aria-hidden="true"
        />
      )}

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Mobile top bar with hamburger (hidden on desktop) */}
        <div
          className="lg:hidden flex items-center gap-3 px-4 h-14 flex-shrink-0"
          style={{ background: "var(--color-surface)", borderBottom: "1px solid var(--color-border)" }}
        >
          <button
            type="button"
            aria-label="Open navigation menu"
            onClick={() => setMobileOpen(true)}
            className="flex items-center justify-center w-9 h-9 rounded-lg"
            style={{ border: "1px solid var(--color-border-strong)" }}
          >
            <Menu size={18} style={{ color: "var(--color-text-2)" }} />
          </button>
          <img src="/IFS%20Logo.svg" alt="IFS Logo" style={{ height: 26, width: "auto" }} />
        </div>

        {children}
      </div>

      {rightPanel}
    </div>
  );
}
