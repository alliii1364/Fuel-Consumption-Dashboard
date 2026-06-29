"use client";

import { memo } from "react";
import {
  LayoutDashboard, Route, FileText, BarChart3, Navigation, ShieldAlert,
  Radio, LogOut, ChevronsLeft, ChevronsRight,
} from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useRouter, usePathname } from "next/navigation";

const navItems = [
  { icon: LayoutDashboard, label: "Dashboard",    href: "/",                 badge: null },
  { icon: BarChart3,       label: "Analytics",    href: "/analytics",        badge: "NEW" },
  { icon: Route,           label: "Routes",       href: "/routes",           badge: null },
  { icon: Navigation,      label: "Dispatch",     href: "/dispatch",         badge: "NEW" },
  { icon: Radio,           label: "Live Monitor", href: "/dispatch/monitor", badge: "NEW" },
  { icon: ShieldAlert,     label: "Theft",        href: "/theft",            badge: null },
  { icon: FileText,        label: "Reports",      href: "/reports",          badge: null },
];

interface SidebarProps {
  /** Desktop icon-only collapse */
  collapsed?: boolean;
  /** Mobile off-canvas drawer open */
  mobileOpen?: boolean;
  /** Called when a nav action should dismiss the mobile drawer */
  onCloseMobile?: () => void;
  /** Toggle desktop collapse (omit to hide the toggle) */
  onToggleCollapse?: () => void;
}

const Sidebar = memo(function Sidebar({
  collapsed = false,
  mobileOpen = false,
  onCloseMobile,
  onToggleCollapse,
}: SidebarProps) {
  const { logout } = useAuth();
  const router   = useRouter();
  const pathname = usePathname();

  // Derive active label from current URL — prefer the most specific (longest) match
  // so e.g. /dispatch/monitor highlights "Live Monitor", not "Dispatch".
  const active = navItems
    .filter(n => n.href && (n.href === "/" ? pathname === "/" : pathname.startsWith(n.href)))
    .sort((a, b) => b.href.length - a.href.length)[0]?.label ?? "Dashboard";

  function go(href: string) {
    if (href) router.push(href);
    onCloseMobile?.();
  }
  function handleLogout() { logout(); router.replace("/login"); }

  return (
    <aside
      className={`fixed lg:static inset-y-0 left-0 z-40 lg:z-20 h-screen flex flex-col py-5 transition-[transform,width] duration-200 ${collapsed ? "px-2" : "px-3"} ${mobileOpen ? "translate-x-0 shadow-2xl" : "-translate-x-full"} lg:translate-x-0 lg:shadow-none`}
      style={{ background: "var(--color-surface)", borderRight: "1px solid var(--color-border)", width: collapsed ? 72 : 220, flexShrink: 0 }}
    >
      {/* Logo */}
      <div className="flex items-center justify-center mb-6" style={{ minHeight: 40 }}>
        <img
          src="/IFS%20Logo.svg"
          alt="IFS Logo"
          style={{ width: collapsed ? 40 : "100%", height: "auto", maxHeight: collapsed ? 36 : 80 }}
        />
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 flex-1">
        {navItems.map(({ icon: Icon, label, href, badge }) => {
          const isActive = active === label;
          return (
            <button
              key={label}
              onClick={() => go(href)}
              className={`nav-item${isActive ? " nav-active" : ""}${collapsed ? " justify-center" : ""}`}
              aria-current={isActive ? "page" : undefined}
              title={collapsed ? label : undefined}
            >
              <Icon size={15} className="nav-icon" style={{ color: isActive ? "#FFF" : "var(--color-text-3)", flexShrink: 0 }} />
              {!collapsed && (
                <span
                  className="nav-label text-sm font-medium flex-1"
                  style={{ color: isActive ? "#FFF" : "var(--color-text-2)" }}
                >
                  {label}
                </span>
              )}
              {!collapsed && badge && (
                <span
                  className="text-xs font-bold px-2 py-0.5 rounded-full"
                  style={isActive
                    ? { background: "rgba(255,255,255,0.25)", color: "#FFF" }
                    : { background: "rgba(var(--color-primary-rgb), 0.1)", color: "var(--color-primary)" }}
                >
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Bottom nav */}
      <div className="flex flex-col gap-0.5">
        <div className="border-t mb-2" style={{ borderColor: "var(--color-border)" }} />
        <button
          onClick={handleLogout}
          className={`nav-item${collapsed ? " justify-center" : ""}`}
          title={collapsed ? "Log Out" : undefined}
        >
          <LogOut size={15} className="nav-icon" style={{ color: "var(--color-text-3)" }} />
          {!collapsed && <span className="nav-label text-sm font-medium" style={{ color: "var(--color-text-2)" }}>Log Out</span>}
        </button>

        {/* Desktop collapse toggle */}
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className={`nav-item hidden lg:flex${collapsed ? " justify-center" : ""}`}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed
              ? <ChevronsRight size={15} className="nav-icon" style={{ color: "var(--color-text-3)" }} />
              : <ChevronsLeft  size={15} className="nav-icon" style={{ color: "var(--color-text-3)" }} />}
            {!collapsed && <span className="nav-label text-sm font-medium" style={{ color: "var(--color-text-2)" }}>Collapse</span>}
          </button>
        )}
      </div>
    </aside>
  );
});

export default Sidebar;
