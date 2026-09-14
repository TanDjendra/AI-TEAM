/**
 * WorkflowValidator — deterministic, in-process DAG validation.
 *
 * Pure and stateless: no DB calls, no async I/O, no side effects.
 * Designed to run before any persistence call so an invalid spec
 * never touches the database.
 *
 * Checks (in order):
 *   1. At least one node exists
 *   2. All node keys are unique within the workflow
 *   3. All edge endpoints exist in the node list
 *   4. No self-edges (from === to)
 *   5. Strict DAG acyclicity — Kahn's topological sort (O(V+E), iterative)
 *   6. Node count ≤ MAX_NODES
 *   7. Edge count ≤ MAX_EDGES
 *   8. Profile bindings reference keys that exist in the node list
 *   9. Single write-resource: exactly one workspace binding style per workflow
 *      and all nodes share it (enforced by the spec structure — only one
 *      workspaceBinding per WorkflowSpec).
 */

import type {
  WorkflowEdgeDecl,
  WorkflowNodeDecl,
  WorkflowSpec,
} from "../domain/workflow.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type WorkflowValidationErrorCode =
  | "EMPTY_NODES"
  | "DUPLICATE_NODE_KEY"
  | "UNKNOWN_DEPENDENCY_NODE"
  | "SELF_EDGE"
  | "CYCLE_DETECTED"
  | "MAX_NODES_EXCEEDED"
  | "MAX_EDGES_EXCEEDED"
  | "INVALID_PROFILE_REF"
  | "MULTIPLE_WRITE_RESOURCES"
  | "INVALID_ARTIFACT_INPUT";

export interface ValidationError {
  code: WorkflowValidationErrorCode;
  message: string;
  /** The node key(s) implicated in the error, when applicable. */
  nodes?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Configurable limits — large enough for any realistic workflow
// ---------------------------------------------------------------------------

export const MAX_NODES_DEFAULT = 128;
export const MAX_EDGES_DEFAULT = 512;

export interface WorkflowValidatorOptions {
  maxNodes?: number;
  maxEdges?: number;
}

// ---------------------------------------------------------------------------
// WorkflowValidator
// ---------------------------------------------------------------------------

export class WorkflowValidator {
  private readonly maxNodes: number;
  private readonly maxEdges: number;

  constructor(options: WorkflowValidatorOptions = {}) {
    this.maxNodes = options.maxNodes ?? MAX_NODES_DEFAULT;
    this.maxEdges = options.maxEdges ?? MAX_EDGES_DEFAULT;
  }

  /**
   * Validates `spec` exhaustively.
   *
   * Returns `{ valid: true, errors: [] }` on success.
   * Returns `{ valid: false, errors: [...] }` otherwise.
   *
   * Structural checks (1–4) run before the cycle check (5) so a caller can
   * fix ordering problems without also having to interpret a cycle error that
   * arose purely because a referenced node didn't exist.
   */
  validate(spec: WorkflowSpec): ValidationResult {
    const errors: ValidationError[] = [];

    // ── 1. At least one node ──────────────────────────────────────────────
    if (!spec.nodes || spec.nodes.length === 0) {
      errors.push({
        code: "EMPTY_NODES",
        message: "A workflow must contain at least one node.",
      });
      // No further checks make sense without nodes.
      return { valid: false, errors };
    }

    // ── 2. Unique node keys ───────────────────────────────────────────────
    const nodeKeys = new Set<string>();
    const duplicateKeys: string[] = [];
    for (const node of spec.nodes) {
      if (nodeKeys.has(node.key)) {
        duplicateKeys.push(node.key);
      } else {
        nodeKeys.add(node.key);
      }
    }
    if (duplicateKeys.length > 0) {
      errors.push({
        code: "DUPLICATE_NODE_KEY",
        message: `Duplicate node keys found: ${duplicateKeys.join(", ")}`,
        nodes: duplicateKeys,
      });
    }

    // ── 3. Edge endpoints exist ───────────────────────────────────────────
    const edges = spec.edges ?? [];
    const unknownNodes: string[] = [];
    for (const edge of edges) {
      if (!nodeKeys.has(edge.from) && !unknownNodes.includes(edge.from)) {
        unknownNodes.push(edge.from);
      }
      if (!nodeKeys.has(edge.to) && !unknownNodes.includes(edge.to)) {
        unknownNodes.push(edge.to);
      }
    }
    if (unknownNodes.length > 0) {
      errors.push({
        code: "UNKNOWN_DEPENDENCY_NODE",
        message: `Edge(s) reference node key(s) not declared in nodes: ${unknownNodes.join(", ")}`,
        nodes: unknownNodes,
      });
    }

    // ── 4. No self-edges ──────────────────────────────────────────────────
    const selfEdges: string[] = [];
    for (const edge of edges) {
      if (edge.from === edge.to && !selfEdges.includes(edge.from)) {
        selfEdges.push(edge.from);
      }
    }
    if (selfEdges.length > 0) {
      errors.push({
        code: "SELF_EDGE",
        message: `Self-edges are not allowed: ${selfEdges.map((k) => `${k} → ${k}`).join(", ")}`,
        nodes: selfEdges,
      });
    }

    // ── 5. DAG acyclicity — Kahn's topological sort ───────────────────────
    // Only run when we have valid node keys and no self-edges (otherwise the
    // in-degree map would be unreliable).
    if (duplicateKeys.length === 0 && unknownNodes.length === 0 && selfEdges.length === 0) {
      const cycleNodes = detectCycle(spec.nodes, edges);
      if (cycleNodes.length > 0) {
        errors.push({
          code: "CYCLE_DETECTED",
          message: `Dependency cycle detected involving node(s): ${cycleNodes.join(", ")}`,
          nodes: cycleNodes,
        });
      }
    }

    // ── 6. Node count limit ───────────────────────────────────────────────
    if (spec.nodes.length > this.maxNodes) {
      errors.push({
        code: "MAX_NODES_EXCEEDED",
        message: `Workflow has ${spec.nodes.length} nodes, maximum allowed is ${this.maxNodes}.`,
      });
    }

    // ── 7. Edge count limit ───────────────────────────────────────────────
    if (edges.length > this.maxEdges) {
      errors.push({
        code: "MAX_EDGES_EXCEEDED",
        message: `Workflow has ${edges.length} edges, maximum allowed is ${this.maxEdges}.`,
      });
    }

    // ── 8. Profile bindings reference existing node keys ─────────────────
    if (spec.profileBindings) {
      const invalidProfileKeys: string[] = [];
      for (const key of Object.keys(spec.profileBindings)) {
        if (!nodeKeys.has(key)) {
          invalidProfileKeys.push(key);
        }
      }
      if (invalidProfileKeys.length > 0) {
        errors.push({
          code: "INVALID_PROFILE_REF",
          message: `profileBindings reference node key(s) not declared in nodes: ${invalidProfileKeys.join(", ")}`,
          nodes: invalidProfileKeys,
        });
      }
    }

    // ── 9. Single write-resource ──────────────────────────────────────────
    // The WorkflowSpec has exactly one workspaceBinding shared by all nodes,
    // so multi-workspace drift is impossible by construction. We still verify
    // that at least one binding type is present and that they are not
    // contradictory (both slug AND path set simultaneously).
    const binding = spec.workspaceBinding;
    const hasSlug = typeof binding?.slug === "string" && binding.slug.trim().length > 0;
    const hasPath = typeof binding?.path === "string" && binding.path.trim().length > 0;

    if (hasSlug && hasPath) {
      errors.push({
        code: "MULTIPLE_WRITE_RESOURCES",
        message:
          "workspaceBinding must specify either 'slug' or 'path', not both. " +
          "A workflow may only bind to one write-resource.",
      });
    } else if (!hasSlug && !hasPath) {
      errors.push({
        code: "MULTIPLE_WRITE_RESOURCES",
        message:
          "workspaceBinding must specify either 'slug' or 'path'. " +
          "A workflow requires exactly one workspace write-resource.",
      });
    }

    // ── 10. Artifact Causality & Producer Existence ───────────────────────
    // Only run if the graph is a valid DAG (no cycles, no missing nodes).
    if (duplicateKeys.length === 0 && unknownNodes.length === 0 && selfEdges.length === 0) {
      const cycleNodes = detectCycle(spec.nodes, edges);
      if (cycleNodes.length === 0) {
        // Build map of what each node produces
        const nodeOutputs = new Map<string, Set<string>>();
        for (const node of spec.nodes) {
          const outputs = new Set<string>();
          for (const out of (node.outputs ?? [])) {
            outputs.add(out.name);
          }
          nodeOutputs.set(node.key, outputs);
        }

        // Build direct predecessors
        const directPredecessors = new Map<string, Set<string>>();
        for (const node of spec.nodes) {
          directPredecessors.set(node.key, new Set<string>());
        }
        for (const edge of edges) {
          if (edge.from !== edge.to && directPredecessors.has(edge.to)) {
            directPredecessors.get(edge.to)!.add(edge.from);
          }
        }

        // Compute transitive ancestors
        const ancestors = new Map<string, Set<string>>();
        const getAncestors = (nodeKey: string): Set<string> => {
          if (ancestors.has(nodeKey)) {
            return ancestors.get(nodeKey)!;
          }
          const result = new Set<string>();
          for (const pred of (directPredecessors.get(nodeKey) ?? [])) {
            result.add(pred);
            for (const anc of getAncestors(pred)) {
              result.add(anc);
            }
          }
          ancestors.set(nodeKey, result);
          return result;
        };
        for (const node of spec.nodes) {
          getAncestors(node.key);
        }

        // Validate inputs
        for (const node of spec.nodes) {
          const inputs = node.inputs ?? [];
          for (const inp of inputs) {
            const producerKey = inp.producerNodeKey;
            
            if (!producerKey) {
              errors.push({
                code: "INVALID_ARTIFACT_INPUT",
                message: `Node '${node.key}' specifies an input '${inp.name}' without a producerNodeKey.`,
                nodes: [node.key],
              });
              continue;
            }

            if (!nodeKeys.has(producerKey)) {
              errors.push({
                code: "INVALID_ARTIFACT_INPUT",
                message: `Node '${node.key}' consumes artifact '${inp.name}' from unknown producer '${producerKey}'.`,
                nodes: [node.key, producerKey],
              });
              continue;
            }

            if (!nodeOutputs.get(producerKey)!.has(inp.name)) {
              errors.push({
                code: "INVALID_ARTIFACT_INPUT",
                message: `Node '${node.key}' consumes artifact '${inp.name}' from '${producerKey}', but '${producerKey}' does not declare it as an output.`,
                nodes: [node.key, producerKey],
              });
            }

            if (!ancestors.get(node.key)!.has(producerKey)) {
              errors.push({
                code: "INVALID_ARTIFACT_INPUT",
                message: `Node '${node.key}' consumes artifact '${inp.name}' from '${producerKey}', but '${producerKey}' is not an upstream ancestor.`,
                nodes: [node.key, producerKey],
              });
            }
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

// ---------------------------------------------------------------------------
// Kahn's Algorithm — pure function, no mutation of the spec
// ---------------------------------------------------------------------------

/**
 * Detects cycles using Kahn's topological sort algorithm (O(V+E), iterative).
 *
 * Returns the keys of nodes that are members of a cycle.
 * Returns an empty array when the graph is a valid DAG.
 *
 * Algorithm:
 *   1. Build an in-degree map (number of incoming edges per node).
 *   2. Seed a queue with every zero-in-degree node.
 *   3. Process the queue: for each dequeued node, decrement the in-degree of
 *      its successors and enqueue any that reach zero.
 *   4. If the visited count equals the total node count → DAG is valid.
 *      Otherwise, the unvisited nodes participate in at least one cycle.
 */
function detectCycle(
  nodes: readonly WorkflowNodeDecl[],
  edges: readonly WorkflowEdgeDecl[],
): string[] {
  // Build adjacency list (successors) and in-degree map.
  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const node of nodes) {
    successors.set(node.key, []);
    inDegree.set(node.key, 0);
  }

  for (const edge of edges) {
    // Self-edges are already reported separately; skip them here to avoid
    // corrupting the in-degree map.
    if (edge.from === edge.to) continue;
    successors.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Seed queue with all zero-in-degree nodes.
  const queue: string[] = [];
  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key);
  }

  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited += 1;

    for (const successor of successors.get(node) ?? []) {
      const newDegree = (inDegree.get(successor) ?? 0) - 1;
      inDegree.set(successor, newDegree);
      if (newDegree === 0) queue.push(successor);
    }
  }

  if (visited === nodes.length) {
    // Every node was processed → no cycle.
    return [];
  }

  // Collect the unvisited nodes — they are inside the cycle(s).
  const processedKeys = new Set<string>();
  // Re-run to collect which ones were visited.
  // Simpler: unvisited = those still with inDegree > 0 after the full pass.
  return [...inDegree.entries()]
    .filter(([, degree]) => degree > 0)
    .map(([key]) => key);
}
