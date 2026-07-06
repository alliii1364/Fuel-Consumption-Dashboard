"use client";

import {
  createContext, useCallback, useContext, useMemo, useRef, useState,
} from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  duration?: number;
  /** When set, clicking the toast body navigates here. */
  href?: string;
}

interface ToastApi {
  show: (t: Omit<ToastItem, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}

const TONE_STYLE: Record<ToastTone, { icon: React.ElementType; color: string; rgb: string }> = {
  success: { icon: CheckCircle2, color: "#16a34a", rgb: "34,197,94" },
  error:   { icon: AlertCircle,  color: "var(--color-primary)", rgb: "var(--color-primary-rgb)" },
  info:    { icon: Info,         color: "#1d4ed8", rgb: "59,130,246" },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((s) => s.filter((t) => t.id !== id));
  }, []);

  const show = useCallback((t: Omit<ToastItem, "id">) => {
    const id = ++idRef.current;
    setItems((s) => [...s, { ...t, id }]);
    if (typeof window !== "undefined") {
      window.setTimeout(() => remove(id), t.duration ?? 4500);
    }
  }, [remove]);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (title, description) => show({ tone: "success", title, description }),
    error:   (title, description) => show({ tone: "error", title, description }),
    info:    (title, description) => show({ tone: "info", title, description }),
  }), [show]);

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <Toaster items={items} onClose={remove} />
    </ToastCtx.Provider>
  );
}

function Toaster({ items, onClose }: { items: ToastItem[]; onClose: (id: number) => void }) {
  if (items.length === 0) return null;
  return (
    <div
      className="fixed bottom-5 right-5 flex flex-col gap-2.5"
      style={{ zIndex: 2147483647, maxWidth: "calc(100vw - 40px)" }}
      role="region"
      aria-label="Notifications"
    >
      {items.map((t) => {
        const s = TONE_STYLE[t.tone];
        const Icon = s.icon;
        return (
          <div
            key={t.id}
            role="status"
            aria-live="polite"
            className="card anim-1 flex items-start gap-3 p-3.5 pr-2.5"
            style={{ width: 340, borderLeft: `3px solid ${s.color}` }}
          >
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
              style={{ background: `rgba(${s.rgb}, 0.1)` }}
            >
              <Icon size={15} style={{ color: s.color }} />
            </div>
            <div
              className={`flex-1 min-w-0${t.href ? " cursor-pointer" : ""}`}
              onClick={t.href ? () => { window.location.href = t.href!; onClose(t.id); } : undefined}
            >
              <p className="text-sm font-semibold" style={{ color: "var(--color-text-1)" }}>{t.title}</p>
              {t.description && (
                <p className="text-xs mt-0.5 break-words" style={{ color: "var(--color-text-2)" }}>{t.description}</p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onClose(t.id)}
              className="flex items-center justify-center w-6 h-6 rounded-md flex-shrink-0"
              style={{ color: "var(--color-text-3)" }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
