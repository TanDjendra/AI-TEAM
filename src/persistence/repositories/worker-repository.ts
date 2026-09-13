import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import { asIso, asNumber, asString, requireRow, type Row } from "../rows.js";

export interface WorkerNodeRecord {
  id: string;
  processId: number;
  status: "RUNNING" | "STOPPING" | "STOPPED" | "DEGRADED";
  startedAt: string;
  heartbeatAt: string;
}

export interface WorkerRepository {
  register(processId: number): Promise<WorkerNodeRecord>;
  heartbeat(id: string, status?: "RUNNING" | "STOPPING" | "STOPPED" | "DEGRADED"): Promise<void>;
  listActive(staleThresholdMs?: number): Promise<WorkerNodeRecord[]>;
}

export function mapWorkerNode(row: Row): WorkerNodeRecord {
  return {
    id: asString(row.id),
    processId: asNumber(row.process_id),
    status: asString(row.status) as "RUNNING" | "STOPPING" | "STOPPED" | "DEGRADED",
    startedAt: asIso(row.started_at),
    heartbeatAt: asIso(row.heartbeat_at),
  };
}

export class PostgresWorkerRepository extends Repository implements WorkerRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async register(processId: number): Promise<WorkerNodeRecord> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const rows = await tx.query(
          `insert into worker_nodes (process_id, status) values ($1, 'RUNNING') returning *`,
          [processId]
        );
        return mapWorkerNode(requireRow(rows, "worker.register"));
      })
    );
  }

  async heartbeat(id: string, status?: "RUNNING" | "STOPPING" | "STOPPED" | "DEGRADED"): Promise<void> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        if (status) {
          await tx.query(
            `update worker_nodes set heartbeat_at = now(), status = $2 where id = $1`,
            [id, status]
          );
        } else {
          await tx.query(
            `update worker_nodes set heartbeat_at = now() where id = $1`,
            [id]
          );
        }
      })
    );
  }

  async listActive(staleThresholdMs: number = 30000): Promise<WorkerNodeRecord[]> {
    const rows = await this.tx().query(
      `select * from worker_nodes 
       where heartbeat_at >= now() - ($1::int * interval '1 millisecond')
         and status != 'STOPPED'
       order by started_at desc`,
      [staleThresholdMs]
    );
    return rows.map(mapWorkerNode);
  }
}
