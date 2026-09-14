/**
 * Public API of the AI Team Orchestrator.
 *
 * Import from here rather than from deep paths: the layout below is stable,
 * individual file locations are not.
 */

// Domain
export * from "./domain/types.js";
export * from "./domain/task-machine.js";
export * from "./domain/errors.js";
export * from "./domain/run-session.js";
export * from "./domain/review-evidence.js";
export {
  createLogger,
  silentLogger,
  isLogLevel,
  LOG_LEVELS,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type LogFormat,
  type LogRecord,
} from "./domain/logger.js";

// Configuration
export {
  loadConfig,
  describeConfig,
  parseDotEnv,
  readRouterCliSecret,
  ConfigError,
  MAX_REVIEW_CYCLES_DEFAULT,
  type AppConfig,
  type RouterConfig,
  type CoderConfig,
  type ReviewerConfig,
  type OrchestratorConfig,
  type LoggingConfig,
  type LoadConfigOptions,
} from "./config/env.js";

// Providers
export type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelMessage,
  ModelUsage,
  ChatRole,
  ProviderHealth,
  ChatStreamChunk,
} from "./providers/model-provider.js";
export {
  RouterProvider,
  parseChatResponse,
  parseToolCalls as parseProviderToolCalls,
  stripTrailingSseFrames,
  type RouterProviderOptions,
} from "./providers/router-provider.js";

// Agents
export {
  Workspace,
  WorkspaceBoundaryError,
  snapshotWorkspace,
  type FileChange,
  type FileEntry,
} from "./agents/workspace.js";
export {
  CommandRunner,
  createCoderTools,
  toolsAsJsonSchema,
  renderToolCatalog,
  DEFAULT_COMMAND_TIMEOUT_MS,
  type ToolDefinition,
  type ToolExecutionResult,
  type ToolExecutionMeta,
  type CommandResult,
} from "./agents/tools.js";
export { CoderAgent, type CoderAgentOptions } from "./agents/coder-agent.js";
export { ReviewerAgent, type ReviewerAgentOptions } from "./agents/reviewer-agent.js";
export {
  buildReviewEvidence,
  renderEvidence,
} from "./agents/evidence.js";
export {
  extractJsonObject,
  parseToolCalls,
  nativeToolCallToToolCall,
  addUsage,
  emptyUsage,
  type ToolCall,
} from "./agents/base-agent.js";
export {
  coderSystemPrompt,
  REVIEWER_SYSTEM_PROMPT,
  CODER_OUTPUT_CONTRACT,
  REVIEWER_OUTPUT_CONTRACT,
} from "./agents/prompts.js";

// Orchestration
export {
  OrchestratorService,
  workspacePathFor,
  CODER_AGENT_KEY,
  REVIEWER_AGENT_KEY,
  type OrchestratorOptions,
} from "./orchestration/runner.js";
export { createRuntime, type Runtime, type RuntimeOptions } from "./orchestration/container.js";
export {
  summarizeRun,
  renderRunReport,
  type RunSummary,
} from "./orchestration/report.js";
export {
  createPersistenceHooks,
  nullHooks,
  type OrchestratorHooks,
  type PersistenceHooksOptions,
} from "./orchestration/persistence-hooks.js";

// Events
export {
  TASK_EVENT_TYPES,
  TERMINAL_EVENT_TYPES,
  isEventOfType,
  isTerminalEvent,
  type AgentRole,
  type AnyTaskEvent,
  type TaskEvent,
  type TaskEventPayload,
  type TaskEventPayloadMap,
  type TaskEventType,
  type TaskStatus,
} from "./events/types.js";
export {
  createEventBus,
  makeEvent,
  defaultEventId,
  type BusError,
  type EventBus,
  type EventBusOptions,
  type EventBusStats,
  type EventListener,
  type EventTransport,
} from "./events/bus.js";
export {
  InMemoryEventTransport,
  WebSocketEventTransport,
  SupabaseRealtimeEventTransport,
  CompositeEventTransport,
  type WebSocketTransportOptions,
  type SupabaseRealtimeTransportOptions,
  type SupabaseRealtimeClient,
} from "./events/transports.js";

// Persistence
export {
  createDb,
  withTransaction,
  withDbRetry,
  isTransient,
  DatabaseError,
  type Db,
  type DbClient,
  type UnitOfWork,
  type Driver,
  type DriverConnection,
} from "./persistence/db.js";
export { PgDriver, PgliteDriver, type PgDriverOptions } from "./persistence/drivers.js";
export {
  migrate,
  migrateFromDirectory,
  loadMigrations,
  schemaIsReady,
  MIGRATIONS_TABLE,
  type MigrationResult,
} from "./persistence/migrate.js";
export {
  redact,
  redactToJson,
  redactArguments,
  summarizeOutput,
  summarize,
  OUTPUT_SUMMARY_MAX,
  SUMMARY_MAX,
} from "./persistence/redaction.js";
export {
  createPersistence,
  type Persistence,
  type PersistenceOptions,
} from "./persistence/container.js";
export {
  createEventRecorder,
  type EventRecorder,
  type RecorderRepositories,
  type RunContext,
} from "./persistence/repositories/event-recorder.js";
export {
  PostgresTaskRepository,
  isMachineState,
  isTerminalStatus,
  knownTransition,
  type ClaimOutcome,
  type CreateTaskInput,
  type TaskRecord,
  type TaskRepository,
  type TransitionInput,
  type TransitionOutcome,
} from "./persistence/repositories/task-repository.js";
export {
  PostgresAgentRepository,
  type AgentRecord,
  type AgentRepository,
  type AgentStatus,
} from "./persistence/repositories/agent-repository.js";
export {
  PostgresRunRepository,
  type RunRecord,
  type RunRepository,
  type RunStatus,
} from "./persistence/repositories/run-repository.js";
export {
  PostgresReviewRepository,
  type ReviewRecord,
  type ReviewRepository,
  type SaveReviewInput,
} from "./persistence/repositories/review-repository.js";
export {
  PostgresActivityLogRepository,
  type ActivityLogRecord,
  type ActivityLogRepository,
  type AppendActivityInput,
} from "./persistence/repositories/activity-log-repository.js";
export {
  PostgresToolCallRepository,
  type ToolCallRecord,
  type ToolCallRepository,
} from "./persistence/repositories/tool-call-repository.js";
export {
  PostgresFileChangeRepository,
  type FileChangeRecord,
  type FileChangeRepository,
  type FileChangeType,
} from "./persistence/repositories/file-change-repository.js";
export {
  PostgresTestResultRepository,
  AUTHORITATIVE_TEST_KEY,
  type TestResultRecord,
  type TestResultRepository,
} from "./persistence/repositories/test-result-repository.js";

export const VERSION = "0.1.0";
