import { describe, expect, it } from "vitest";
import { WorkflowPlanner, PlannerError } from "../../src/orchestration/workflow-planner.js";
import type { ModelProvider, ModelRequest, ModelResponse, ChatStreamChunk, ProviderHealth, ModelMetadata } from "../../src/providers/model-provider.js";
import type { WorkspaceBinding } from "../../src/domain/workflow.js";

class MockModelProvider implements ModelProvider {
  readonly id = "mock";
  readonly baseUrl = "http://localhost";
  
  public responses: string[] = [];
  public requests: ModelRequest[] = [];

  async chat(input: ModelRequest): Promise<ModelResponse> {
    this.requests.push(input);
    const content = this.responses.shift();
    if (content === undefined) {
      throw new Error("Mock out of responses");
    }
    return {
      id: "test-id",
      resolvedModel: input.model,
      requestedModel: input.model,
      content,
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
      latencyMs: 10,
      attempts: 1,
    };
  }

  async *chatStream(): AsyncGenerator<ChatStreamChunk, ModelResponse, void> {
    throw new Error("Not implemented");
  }

  async listModels(): Promise<string[]> {
    return ["mock-model"];
  }

  async health(): Promise<ProviderHealth> {
    return { ok: true, baseUrl: this.baseUrl, latencyMs: 1 };
  }
}

describe("WorkflowPlanner", () => {
  const workspaceBinding: WorkspaceBinding = { slug: "test-workspace" };
  const objective = "Build a React app";

  it("succeeds on the first try with a valid DAG", async () => {
    const mockProvider = new MockModelProvider();
    mockProvider.responses = [
      JSON.stringify({
        rationale: "mock rationale",
        nodes: [
          { key: "a", title: "A" },
          { key: "b", title: "B" }
        ],
        edges: [
          { from: "a", to: "b" }
        ]
      })
    ];

    const planner = new WorkflowPlanner({
      modelProvider: mockProvider,
      modelId: "mock-model"
    });

    const spec = await planner.plan(objective, workspaceBinding);
    expect(spec.objective).toBe(objective);
    expect(spec.workspaceBinding).toEqual(workspaceBinding);
    expect(spec.nodes).toHaveLength(2);
    expect(spec.edges).toHaveLength(1);
    expect(mockProvider.requests).toHaveLength(1);
  });

  it("retries on JSON parse error and succeeds", async () => {
    const mockProvider = new MockModelProvider();
    mockProvider.responses = [
      "This is not JSON",
      JSON.stringify({
        rationale: "mock rationale",
        nodes: [{ key: "a", title: "A" }],
        edges: []
      })
    ];

    const planner = new WorkflowPlanner({
      modelProvider: mockProvider,
      modelId: "mock-model"
    });

    const spec = await planner.plan(objective, workspaceBinding);
    expect(spec.nodes).toHaveLength(1);
    expect(mockProvider.requests).toHaveLength(2);
    const retryRequest = mockProvider.requests[1];
    expect(retryRequest!.messages[retryRequest!.messages.length - 1]!.content).toContain("not valid JSON");
  });

  it("retries on schema validation error and succeeds", async () => {
    const mockProvider = new MockModelProvider();
    mockProvider.responses = [
      JSON.stringify({
        rationale: "mock rationale",
        nodes: [{ title: "Missing key" }], // invalid schema
        edges: []
      }),
      JSON.stringify({
        rationale: "mock rationale",
        nodes: [{ key: "a", title: "A" }],
        edges: []
      })
    ];

    const planner = new WorkflowPlanner({
      modelProvider: mockProvider,
      modelId: "mock-model"
    });

    const spec = await planner.plan(objective, workspaceBinding);
    expect(spec.nodes).toHaveLength(1);
    expect(mockProvider.requests).toHaveLength(2);
    const retryRequest = mockProvider.requests[1];
    expect(retryRequest!.messages[retryRequest!.messages.length - 1]!.content).toContain("match the required schema");
  });

  it("retries on DAG validation error and succeeds", async () => {
    const mockProvider = new MockModelProvider();
    mockProvider.responses = [
      JSON.stringify({
        rationale: "mock rationale",
        nodes: [
          { key: "a", title: "A" }
        ],
        edges: [
          { from: "a", to: "a" } // self-edge
        ]
      }),
      JSON.stringify({
        rationale: "mock rationale",
        nodes: [{ key: "a", title: "A" }],
        edges: []
      })
    ];

    const planner = new WorkflowPlanner({
      modelProvider: mockProvider,
      modelId: "mock-model"
    });

    const spec = await planner.plan(objective, workspaceBinding);
    expect(spec.nodes).toHaveLength(1);
    expect(mockProvider.requests).toHaveLength(2);
    const retryRequest = mockProvider.requests[1];
    expect(retryRequest!.messages[retryRequest!.messages.length - 1]!.content).toContain("SELF_EDGE");
  });

  it("throws PlannerError when maxRetries is exceeded", async () => {
    const mockProvider = new MockModelProvider();
    mockProvider.responses = [
      "bad 1",
      "bad 2",
      "bad 3",
      "bad 4" // for maxRetries = 3, it tries 4 times (attempt 0, 1, 2, 3)
    ];

    const planner = new WorkflowPlanner({
      modelProvider: mockProvider,
      modelId: "mock-model",
      maxRetries: 3
    });

    await expect(planner.plan(objective, workspaceBinding)).rejects.toThrow(PlannerError);
    expect(mockProvider.requests).toHaveLength(4);
  });
});
