"use client";

import * as React from "react";
import { cn } from "../lib/utils.js";
import type { WorkflowView, WorkflowNodeView } from "../../src/dashboard/service.js";

interface DagVisualizerProps {
  workflow: WorkflowView;
  nodes: WorkflowNodeView[];
  className?: string;
}

function nodeColor(status: string) {
  switch (status) {
    case "PENDING":
    case "WAITING_DEPENDENCIES":
      return "bg-[var(--surface-sunken)] border-[var(--border-subtle)] opacity-60";
    case "READY":
      return "bg-[var(--surface)] border-[var(--border-strong)]";
    case "CLAIMED":
    case "RUNNING":
      return "bg-[var(--info-bg)] border-[var(--info)] text-[var(--info-fg)]";
    case "BLOCKED":
      return "bg-[var(--warning-bg)] border-[var(--warning)] text-[var(--warning-fg)]";
    case "DONE":
    case "SUCCEEDED":
      return "bg-[var(--ok-bg)] border-[var(--ok)] text-[var(--ok-fg)]";
    case "FAILED":
    case "CANCELLED":
      return "bg-[var(--danger-bg)] border-[var(--danger)] text-[var(--danger-fg)]";
    default:
      return "bg-[var(--surface)] border-[var(--border-subtle)]";
  }
}

export function DagVisualizer({ workflow, nodes, className }: DagVisualizerProps) {
  // Simple topological sort / grouping for visualization
  const layers: WorkflowNodeView[][] = [];
  const placed = new Set<string>();
  
  const getDependencies = (nodeKey: string) => 
    workflow.spec.edges.filter((e: any) => e.to === nodeKey).map((e: any) => e.from);
  
  let remaining = [...nodes];
  while (remaining.length > 0) {
    const layer = remaining.filter((n) => {
      const deps = getDependencies(n.nodeKey);
      return deps.length === 0 || deps.every((d: string) => placed.has(d));
    });
    
    if (layer.length === 0) {
      // Cycle or broken dependencies, just dump the rest
      layers.push(remaining);
      break;
    }
    
    layers.push(layer);
    layer.forEach((n) => placed.add(n.nodeKey));
    remaining = remaining.filter((n) => !placed.has(n.nodeKey));
  }

  return (
    <div className={cn("p-6 overflow-auto border border-[var(--border-subtle)] rounded-lg bg-[var(--surface-sunken)]", className)}>
      <div className="flex flex-col items-center gap-8 min-w-max">
        {layers.map((layer, i) => (
          <div key={i} className="flex gap-6 relative">
            {layer.map((node) => (
              <div 
                key={node.nodeKey}
                className={cn(
                  "relative flex flex-col items-center justify-center p-3 rounded-md border w-40 text-center shadow-sm",
                  nodeColor(node.status)
                )}
              >
                <div className="text-[12px] font-mono font-bold truncate w-full">{node.nodeKey}</div>
                <div className="text-[10px] mt-1 opacity-80 uppercase tracking-widest">{node.status}</div>
                {node.currentTaskId && (
                  <div className="text-[9px] mt-2 truncate w-full font-mono opacity-70">
                    Task: {node.currentTaskId.split('-').pop()}
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
