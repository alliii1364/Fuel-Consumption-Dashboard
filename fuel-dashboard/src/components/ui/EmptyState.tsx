"use client";

/**
 * Standard empty state — icon + title + optional description + optional action.
 * Replaces the assorted ad-hoc "No data" / dashed-box / silent-null patterns.
 */

interface EmptyStateProps {
  icon?: React.ElementType;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export default function EmptyState({ icon: Icon, title, description, action, className = "" }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-12 px-6 ${className}`}>
      {Icon && (
        <div
          className="w-12 h-12 rounded-2xl flex items-center justify-center mb-3"
          style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border-soft)" }}
        >
          <Icon size={22} style={{ color: "var(--color-text-3)" }} />
        </div>
      )}
      <p className="text-sm font-semibold" style={{ color: "var(--color-text-1)" }}>{title}</p>
      {description && (
        <p className="text-xs mt-1 max-w-xs" style={{ color: "var(--color-text-3)" }}>{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
