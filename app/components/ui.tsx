/**
 * Small shadcn-style primitive set.
 *
 * Kept minimal and local: only the variants the dashboard actually uses. Each
 * component reads from the CSS variables in globals.css, so light/dark works
 * without a theme prop.
 */

import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.js";
import { TONE_STYLES, type ToneKey } from "../lib/status.js";

// --- Card -------------------------------------------------------------------

export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("panel", className)} {...props} />;
}

export function PanelHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5",
        className,
      )}
      {...props}
    />
  );
}

export function PanelTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      className={cn("text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--content-faint)]", className)}
      {...props}
    />
  );
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}

// --- Badge ------------------------------------------------------------------

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium leading-tight whitespace-nowrap",
  {
    variants: {
      tone: {
        ok: "",
        warn: "",
        danger: "",
        info: "",
        neutral: "",
        coder: "",
        reviewer: "",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {
  tone?: ToneKey;
  dot?: boolean;
}

export function Badge({ className, tone = "neutral", dot = false, children, ...props }: BadgeProps) {
  const styles = TONE_STYLES[tone];
  return (
    <span className={cn(badgeVariants({ tone }), styles.text, styles.bg, styles.border, className)} {...props}>
      {dot ? <span className={cn("size-1.5 rounded-full", styles.dot)} aria-hidden /> : null}
      {children}
    </span>
  );
}

// --- Button -----------------------------------------------------------------

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-colors " +
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--coder)] " +
    "disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-[var(--content)] text-[var(--surface)] hover:opacity-90",
        outline:
          "border border-[var(--border-subtle)] bg-[var(--surface)] text-[var(--content)] hover:bg-[var(--surface-sunken)]",
        ghost: "text-[var(--content-muted)] hover:bg-[var(--surface-sunken)] hover:text-[var(--content)]",
        danger: "border border-[var(--danger)] text-[var(--danger)] hover:bg-[var(--danger-soft)]",
        ok: "border border-[var(--ok)] text-[var(--ok)] hover:bg-[var(--ok-soft)]",
      },
      size: {
        sm: "h-7 px-2.5",
        md: "h-8 px-3",
      },
    },
    defaultVariants: { variant: "outline", size: "sm" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

// --- Layout helpers ---------------------------------------------------------

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--content-faint)]">
        {label}
      </div>
      <div className="truncate text-sm font-semibold text-[var(--content)]" title={typeof value === "string" ? value : undefined}>
        {value}
      </div>
      {hint ? <div className="truncate text-[11px] text-[var(--content-faint)]">{hint}</div> : null}
    </div>
  );
}

export function KeyValue({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(90px,140px)_1fr] items-baseline gap-2 py-1">
      <dt className="text-[11px] uppercase tracking-wide text-[var(--content-faint)]">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-[var(--content)]">{children}</dd>
    </div>
  );
}

export function Th({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "border-b border-[var(--border-subtle)] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--content-faint)]",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      className={cn("border-b border-[var(--border-subtle)] px-3 py-2 align-top text-xs text-[var(--content)]", className)}
      {...props}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <p className="text-sm font-medium text-[var(--content)]">{title}</p>
      {description ? <p className="max-w-md text-xs text-[var(--content-muted)]">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ message, detail }: { message: string; detail?: string }) {
  return (
    <div className="rounded-md border border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3">
      <p className="text-xs font-semibold text-[var(--danger)]">{message}</p>
      {detail ? <p className="mt-1 break-words font-mono text-[11px] text-[var(--danger)]">{detail}</p> : null}
    </div>
  );
}

export function SkeletonRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-9 animate-pulse rounded-md bg-[var(--surface-sunken)]"
        />
      ))}
    </div>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[11px] text-[var(--content-muted)]", className)}>{children}</span>;
}

// --- Tabs -------------------------------------------------------------------

export const Tabs = TabsPrimitive.Root;

export const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-10 items-center justify-center rounded-md bg-[var(--surface-sunken)] p-1 text-[var(--content-muted)]",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-xs font-medium ring-offset-[var(--surface)] transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-[var(--surface)] data-[state=active]:text-[var(--content)] data-[state=active]:shadow-sm",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-[var(--surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;
