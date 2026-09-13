/**
 * Agent registry and status.
 *
 * Status transitions are persisted, not just held in memory, so a dashboard can
 * show what each agent is doing and a crashed worker's agent does not stay
 * "WORKING" forever (recovery marks it ERROR/OFFLINE).
 */

import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import { asIso, asNullableString, asString, requireRow, type Row } from "../rows.js";
import type { AgentRole } from "../../events/types.js";

export type AgentStatus = "IDLE" | "WORKING" | "REVIEWING" | "ERROR" | "OFFLINE";

export interface AgentRecord {
  id: string;
  agentKey: string;
  role: AgentRole | "orchestrator";
  provider: string;
  model: string;
  status: AgentStatus;
  currentTaskId?: string;
  lastSeen: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterAgentInput {
  agentKey: string;
  role: AgentRecord["role"];
  provider: string;
  model: string;
}

export interface AgentRepository {
  register(input: RegisterAgentInput): Promise<AgentRecord>;
  upsert(input: RegisterAgentInput): Promise<AgentRecord>;
  findById(id: string): Promise<AgentRecord | undefined>;
  findByKey(agentKey: string): Promise<AgentRecord | undefined>;
  list(): Promise<AgentRecord[]>;
  setStatus(
    id: string,
    status: AgentStatus,
    options?: { currentTaskId?: string | null },
  ): Promise<AgentRecord | undefined>;
  heartbeat(id: string): Promise<void>;
}

export function mapAgent(row: Row): AgentRecord {
  return {
    id: asString(row.id),
    agentKey: asString(row.agent_key),
    role: asString(row.role) as AgentRecord["role"],
    provider: asString(row.provider),
    model: asString(row.model),
    status: asString(row.status) as AgentStatus,
    ...(asNullableString(row.current_task_id)
      ? { currentTaskId: asNullableString(row.current_task_id)! }
      : {}),
    lastSeen: asIso(row.last_seen),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

export class PostgresAgentRepository extends Repository implements AgentRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async register(input: RegisterAgentInput): Promise<AgentRecord> {
    try {
      return await this.run(async (tx) => {
        const rows = await tx.query(
          `insert into agents (agent_key, role, provider, model, status)
           values ($1, $2, $3, $4, 'IDLE')
           returning *`,
          [input.agentKey, input.role, input.provider, input.model],
        );
        return mapAgent(requireRow(rows, "agent.insert"));
      });
    } catch (error) {
      // A unique violation means it already exists: idempotent by definition.
      if (isUniqueViolation(error)) {
        const existing = await this.findByKey(input.agentKey);
        if (existing) return existing;
      }
      throw error;
    }
  }

  /** Register-or-update. Safe to call on every process start. */
  async upsert(input: RegisterAgentInput): Promise<AgentRecord> {
    try {
      return await this.run(async (tx) => {
        const rows = await tx.query(
          `insert into agents (agent_key, role, provider, model, status, last_seen)
           values ($1, $2, $3, $4, 'IDLE', now())
           on conflict (agent_key) do update
             set role = excluded.role,
                 provider = excluded.provider,
                 model = excluded.model,
                 last_seen = now()
           returning *`,
          [input.agentKey, input.role, input.provider, input.model],
        );
        return mapAgent(requireRow(rows, "agent.upsert"));
      });
    } catch (error) {
      throw error;
    }
  }

  async findById(id: string): Promise<AgentRecord | undefined> {
    const rows = await this.tx().query("select * from agents where id = $1", [id]);
    return rows[0] ? mapAgent(rows[0]) : undefined;
  }

  async findByKey(agentKey: string): Promise<AgentRecord | undefined> {
    const rows = await this.tx().query("select * from agents where agent_key = $1", [agentKey]);
    return rows[0] ? mapAgent(rows[0]) : undefined;
  }

  async list(): Promise<AgentRecord[]> {
    const rows = await this.tx().query("select * from agents order by agent_key");
    return rows.map(mapAgent);
  }

  async setStatus(
    id: string,
    status: AgentStatus,
    options: { currentTaskId?: string | null } = {},
  ): Promise<AgentRecord | undefined> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const hasTask = options.currentTaskId !== undefined;
        const rows = await tx.query(
          `update agents
              set status = $2,
                  current_task_id = ${hasTask ? "$3" : "current_task_id"},
                  last_seen = now()
            where id = $1
        returning *`,
          hasTask ? [id, status, options.currentTaskId] : [id, status],
        );
        return rows[0] ? mapAgent(rows[0]) : undefined;
      }),
    );
  }

  async heartbeat(id: string): Promise<void> {
    await this.tx().query("update agents set last_seen = now() where id = $1", [id]);
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return true;
  return /duplicate key value violates unique constraint/i.test(
    error instanceof Error ? error.message : String(error),
  );
}
