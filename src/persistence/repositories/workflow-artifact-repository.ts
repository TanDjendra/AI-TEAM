import { randomUUID } from "node:crypto";
import type { Db, UnitOfWork } from "../db.js";
import { Repository, withDbRetry } from "../db.js";
import { asIso, asNumber, asString, requireRow, type Row } from "../rows.js";
import type { ArtifactManifest } from "../../domain/artifact.js";
import type { WorkflowArtifactRepository } from "../../domain/workflow.js";

function mapArtifactRow(row: Row): ArtifactManifest {
  return {
    id: asString(row.id),
    workflowId: asString(row.workflow_id),
    producerNodeKey: asString(row.producer_node_key),
    name: asString(row.name),
    path: asString(row.path),
    checksum: asString(row.checksum),
    sizeBytes: row.size_bytes != null ? asNumber(row.size_bytes) : undefined,
    createdAt: asIso(row.created_at),
  };
}

export class PostgresWorkflowArtifactRepository extends Repository implements WorkflowArtifactRepository {
  constructor(db: Db | UnitOfWork) {
    super(db);
  }

  async create(manifest: Omit<ArtifactManifest, "id" | "createdAt">): Promise<ArtifactManifest> {
    return withDbRetry(async () =>
      this.run(async (tx) => {
        const id = randomUUID();
        const now = new Date().toISOString();

        const rows = await tx.query<Row>(
          `INSERT INTO workflow_artifacts
             (id, workflow_id, producer_node_key, name, path, checksum, size_bytes, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING *`,
          [
            id,
            manifest.workflowId,
            manifest.producerNodeKey,
            manifest.name,
            manifest.path,
            manifest.checksum,
            manifest.sizeBytes ?? null,
            now,
          ],
        );
        return mapArtifactRow(requireRow(rows, "workflow_artifact.create"));
      }),
    );
  }

  async findByProducer(workflowId: string, producerNodeKey: string): Promise<ArtifactManifest[]> {
    const rows = await this.tx().query<Row>(
      `SELECT * FROM workflow_artifacts WHERE workflow_id = $1 AND producer_node_key = $2 ORDER BY created_at`,
      [workflowId, producerNodeKey],
    );
    return rows.map(mapArtifactRow);
  }

  async findByName(workflowId: string, producerNodeKey: string, name: string): Promise<ArtifactManifest | null> {
    const rows = await this.tx().query<Row>(
      `SELECT * FROM workflow_artifacts WHERE workflow_id = $1 AND producer_node_key = $2 AND name = $3`,
      [workflowId, producerNodeKey, name],
    );
    return rows.length > 0 ? mapArtifactRow(rows[0]!) : null;
  }

  async findAll(workflowId: string): Promise<ArtifactManifest[]> {
    const rows = await this.tx().query<Row>(
      `SELECT * FROM workflow_artifacts WHERE workflow_id = $1 ORDER BY created_at`,
      [workflowId],
    );
    return rows.map(mapArtifactRow);
  }
}
