"use client";

/**
 * Semantic status pill. Wraps the design-system `.tag-*` classes so status
 * colors live in one place instead of being redefined per screen
 * (dispatch STATUS_COLORS, theft SEVERITY_CONFIG, online/offline, etc.).
 */

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const TONE_CLASS: Record<StatusTone, string> = {
  success: "tag-green",
  warning: "tag-amber",
  danger:  "tag-red-soft",
  info:    "tag-blue",
  neutral: "tag-gray",
};

/** Map common backend status strings to a tone. Extend as needed. */
const STATUS_TONE: Record<string, StatusTone> = {
  online: "success", active: "success", completed: "success", delivered: "success", ok: "success",
  accepted: "info", en_route: "info", in_progress: "info", inprogress: "info", running: "info",
  assigned: "neutral", pending: "warning", scheduled: "neutral", idle: "neutral",
  delayed: "warning", warning: "warning", low: "warning",
  offline: "danger", cancelled: "danger", canceled: "danger", failed: "danger", critical: "danger", high: "danger",
};

export function statusTone(status: string): StatusTone {
  return STATUS_TONE[status?.toLowerCase?.() ?? ""] ?? "neutral";
}

interface StatusBadgeProps {
  /** Explicit tone, or omit and pass `status` to auto-map. */
  tone?: StatusTone;
  /** Raw backend status string — auto-mapped to a tone via statusTone(). */
  status?: string;
  /** Show a leading dot in the current color. */
  dot?: boolean;
  children?: React.ReactNode;
  className?: string;
}

export default function StatusBadge({ tone, status, dot = false, children, className = "" }: StatusBadgeProps) {
  const resolved = tone ?? (status ? statusTone(status) : "neutral");
  const label = children ?? status?.replace(/_/g, " ");
  return (
    <span
      className={`tag ${TONE_CLASS[resolved]} ${className}`}
      style={dot ? { display: "inline-flex", alignItems: "center", gap: 6 } : undefined}
    >
      {dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />}
      {label}
    </span>
  );
}
