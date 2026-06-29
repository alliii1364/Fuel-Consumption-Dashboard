"use client";

import { Fragment } from "react";
import { ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";

export interface Crumb { label: string; href?: string; }

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  breadcrumbs?: Crumb[];
  /** Right-aligned actions (buttons, filters, selectors). */
  actions?: React.ReactNode;
}

/**
 * Standard page header: breadcrumb trail + title/subtitle + an actions slot.
 * Sits at the top of a page's content column (flex-shrink-0, non-scrolling).
 */
export default function PageHeader({ title, subtitle, breadcrumbs, actions }: PageHeaderProps) {
  const router = useRouter();

  return (
    <header
      className="flex-shrink-0 flex items-start justify-between gap-4 px-6 py-4 anim-1"
    >
      <div className="min-w-0">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label="Breadcrumb" className="flex items-center gap-1 mb-1">
            {breadcrumbs.map((c, i) => {
              const last = i === breadcrumbs.length - 1;
              return (
                <Fragment key={`${c.label}-${i}`}>
                  {c.href && !last ? (
                    <button
                      onClick={() => router.push(c.href!)}
                      className="text-xs font-medium hover:underline"
                      style={{ color: "var(--color-text-3)" }}
                    >
                      {c.label}
                    </button>
                  ) : (
                    <span className="text-xs font-medium" style={{ color: last ? "var(--color-text-2)" : "var(--color-text-3)" }}>
                      {c.label}
                    </span>
                  )}
                  {!last && <ChevronRight size={12} style={{ color: "var(--color-text-3)" }} />}
                </Fragment>
              );
            })}
          </nav>
        )}

        <h1 className="text-xl font-bold truncate" style={{ color: "var(--color-text-1)" }}>{title}</h1>
        {subtitle && (
          <p className="text-xs mt-0.5" style={{ color: "var(--color-text-3)" }}>{subtitle}</p>
        )}
      </div>

      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </header>
  );
}
