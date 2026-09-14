/**
 * Domain contracts for the Artifact Manifest subsystem (Phase V2-06).
 *
 * Artifacts represent structured data passed downstream without raw file
 * pollution or unbounded context growth. They rely on local paths and checksums,
 * strictly NO distributed S3/blob storage.
 */

export interface ArtifactReference {
  /** The name of the artifact to consume or produce. */
  readonly name: string;
  /** The node key that produces the artifact (only required for inputs). */
  readonly producerNodeKey?: string;
  /** Path within the workspace (optional for inputs if auto-resolved, required for outputs). */
  readonly path?: string;
}

export interface ArtifactManifest {
  /** Uniquely identifies this artifact manifest. */
  readonly id: string;
  /** Workflow ID this artifact belongs to. */
  readonly workflowId: string;
  /** Node key that produced this artifact. */
  readonly producerNodeKey: string;
  /** Name of the artifact, e.g. 'compiled-binary', 'test-report'. */
  readonly name: string;
  /** Absolute or workspace-relative local path to the artifact file/folder. */
  readonly path: string;
  /** SHA-256 checksum of the artifact payload for immutability validation. */
  readonly checksum: string;
  /** Optional size in bytes. */
  readonly sizeBytes?: number;
  /** Created timestamp (ISO 8601). */
  readonly createdAt: string;
}
