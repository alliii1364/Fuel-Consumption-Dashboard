"use client";

import { TrendingUp, TrendingDown } from "lucide-react";

/** Convert #RRGGBB hex to "R, G, B" for use in rgba() */
function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}

export interface MetricCardProps {
  icon: React.ElementType;
  /** Accent hex (drives the glassmorphic icon tile + bottom bar). Defaults to brand red. */
  accent?: string;
  label: string;
  value: React.ReactNode;
  trend?: string | null;
  badge?: { text: string; up: boolean } | null;
  className?: string;
}

/**
 * Canonical KPI/metric card. Single implementation replacing the two divergent
 * KPI card components the audit flagged. Glassmorphic accent icon, value, label,
 * optional trend line + up/down badge, accent underline.
 */
export default function MetricCard({
  icon: Icon,
  accent = "#E84040",
  label,
  value,
  trend,
  badge = null,
  className = "",
}: MetricCardProps) {
  const rgb = hexToRgb(accent);
  return (
    <div className={`card p-5 ${className}`}>
      {/* Icon + badge row */}
      <div className="flex items-start justify-between mb-4">
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center"
          style={{
            background: `rgba(${rgb}, 0.12)`,
            border: `1px solid rgba(${rgb}, 0.22)`,
            backdropFilter: "blur(12px)",
            WebkitBackdropFilter: "blur(12px)",
            boxShadow: `0 4px 14px rgba(${rgb}, 0.15), inset 0 1px 0 rgba(255,255,255,0.6)`,
          }}
        >
          <Icon size={19} style={{ color: accent }} />
        </div>
        {badge && (
          <span
            className="text-xs font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"
            style={badge.up
              ? { background: "rgba(34,197,94,0.1)", color: "#16a34a", border: "1px solid rgba(34,197,94,0.2)" }
              : { background: "rgba(var(--color-primary-rgb), 0.1)", color: "var(--color-primary)", border: "1px solid rgba(var(--color-primary-rgb), 0.2)" }}
          >
            {badge.up ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
            {badge.text}
          </span>
        )}
      </div>

      {/* Value */}
      <p className="text-2xl font-bold leading-tight mb-1 tabular-nums" style={{ color: "var(--color-text-1)" }}>
        {value}
      </p>
      <p className="text-sm font-medium" style={{ color: "var(--color-text-3)" }}>{label}</p>

      {/* Trend line */}
      {trend && <p className="text-xs mt-2" style={{ color: "var(--color-text-3)" }}>{trend}</p>}

      {/* Accent bottom bar */}
      <div
        className="h-0.5 rounded-full mt-4"
        style={{ background: `linear-gradient(90deg, ${accent} 0%, transparent 100%)`, opacity: 0.3 }}
      />
    </div>
  );
}
