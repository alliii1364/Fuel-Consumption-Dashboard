"use client";

import { Fuel, Car, Banknote, AlertTriangle, Droplets } from "lucide-react";
import { DashboardSummaryData } from "@/lib/types";
import MetricCard from "@/components/ui/MetricCard";

interface Props {
  data: DashboardSummaryData | null;
  loading: boolean;
}

function SkeletonCard() {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="skeleton w-10 h-10 rounded-xl" />
        <div className="skeleton w-16 h-5 rounded-full" />
      </div>
      <div className="skeleton w-28 h-7 mb-2 rounded-lg" />
      <div className="skeleton w-20 h-4 rounded-lg" />
    </div>
  );
}

export default function KpiMiniCards({ data, loading }: Props) {
  if (loading) {
    return (
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 anim-2">
        {[0,1,2,3].map(i => <SkeletonCard key={i} />)}
      </div>
    );
  }

  const online   = data?.vehicles.filter(v => v.status === "online").length  ?? 0;
  const offline  = data?.vehicles.filter(v => v.status === "offline").length ?? 0;
  const total    = data?.vehicles.length ?? 0;
  const refueled = data?.vehicles.reduce((s, v) => s + (v.refueled ?? 0), 0) ?? 0;

  const kpis = [
    {
      icon: Fuel,
      accent: "#E84040",
      label: "Total Fuel Used",
      value: data ? `${(data.totals.consumed ?? 0).toFixed(1)} L` : "—",
      badge: null as string | null,
      badgeUp: null as boolean | null,
      trend: data ? `Across ${total} vehicle${total !== 1 ? "s" : ""}` : null,
    },
    {
      icon: Droplets,
      accent: "#3B82F6",
      label: "Total Refueled",
      value: data ? `${refueled.toFixed(1)} L` : "—",
      badge: null,
      badgeUp: null,
      trend: "This period",
    },
    {
      icon: Banknote,
      accent: "#22C55E",
      label: "Estimated Cost",
      value: data ? `Rs ${(data.totals.cost ?? 0).toLocaleString()}` : "—",
      badge: null,
      badgeUp: null,
      trend: "This period",
    },
    {
      icon: offline > 0 ? AlertTriangle : Car,
      accent: offline > 0 ? "#F59E0B" : "#22C55E",
      label: offline > 0 ? "Offline Vehicles" : "Active Vehicles",
      value: data ? (offline > 0 ? String(offline) : String(online)) : "—",
      badge: offline === 0 ? "All online" : "Needs check",
      badgeUp: offline === 0,
      trend: offline === 0
        ? `${total > 0 ? Math.round((online / total) * 100) : 0}% active`
        : `${offline} vehicle${offline > 1 ? "s" : ""} down`,
    },
  ];

  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 anim-2">
      {kpis.map((k) => (
        <MetricCard
          key={k.label}
          icon={k.icon}
          accent={k.accent}
          label={k.label}
          value={k.value}
          trend={k.trend}
          badge={k.badge != null ? { text: k.badge, up: !!k.badgeUp } : null}
        />
      ))}
    </div>
  );
}
