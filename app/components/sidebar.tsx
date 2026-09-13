"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { Activity, Bot, LayoutDashboard, ListChecks, Settings, ShieldCheck } from "lucide-react";

import { cn } from "../lib/utils.js";

const NAV = [
  { href: "/", label: "Command Center", icon: LayoutDashboard },
  { href: "/tasks", label: "Tasks", icon: ListChecks },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/reviews", label: "Reviews", icon: ShieldCheck },
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      className="flex shrink-0 flex-row gap-1 border-b border-[var(--border-subtle)] bg-[var(--surface-raised)] px-2 py-2 lg:h-dvh lg:w-56 lg:flex-col lg:border-r lg:border-b-0 lg:px-3 lg:py-4"
    >
      <div className="hidden items-center gap-2 px-2 pb-3 lg:flex">
        <div className="flex size-7 items-center justify-center rounded-md bg-[var(--coder-soft)] text-[var(--coder)]">
          <Bot className="size-4" aria-hidden />
        </div>
        <div className="min-w-0">
          <div className="truncate text-xs font-semibold text-[var(--content)]">AI Team</div>
          <div className="truncate text-[10px] text-[var(--content-faint)]">Orchestrator</div>
        </div>
      </div>

      <ul className="flex flex-1 flex-row gap-1 overflow-x-auto lg:flex-col lg:overflow-x-visible">
        {NAV.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="shrink-0 lg:shrink">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-2 text-xs font-medium transition-colors",
                  active
                    ? "bg-[var(--surface-sunken)] text-[var(--content)]"
                    : "text-[var(--content-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--content)]",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
