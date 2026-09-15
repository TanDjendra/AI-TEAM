const fs = require('fs');

const dummySession = `
const dummySession: import("../../src/domain/run-session.js").RunSession = {
  taskRunId: "test-run",
  taskId: "t-1",
  task: { id: "t-1", title: "test", description: "test", instruction: "test", workspacePath: "" },
  control: { checkInterrupt: false },
  agentKeys: { coder: "test", reviewer: "test" },
  agentIds: { coder: "test", reviewer: "test" }
};
`;

function fixFile(file) {
  let content = fs.readFileSync(file, 'utf8');
  if (!content.includes('dummySession')) {
    if (content.includes('describe(')) {
      content = content.replace(/(describe\(.*\) => \{)/, '$1\n' + dummySession);
    }
  }

  // carefully replace execute({ task: ... }) with execute({ task: ..., session: dummySession, ... })
  content = content.replace(/\.execute\(\{\s*task: ([^,]+),/g, '.execute({ task: $1, session: dummySession,');

  // Also replace runCoder, runReviewer calls with session if any, though they aren't in test usually

  // fix TestAgentInput definition
  content = content.replace(/export type TestAgentInput = Partial<AgentInput> & \{ task: TaskSpec; workspacePath: string; cycle: number \};/, 'export type TestAgentInput = Partial<AgentInput> & { task: TaskSpec; workspacePath: string; cycle: number; session?: import("../../src/domain/run-session.js").RunSession; };');
  content = content.replace(/export type TestAgentInput = Partial<AgentInput> & \{ task: TaskSpec; workspacePath: string; cycle: number; previousReview\?: ReviewerOutput \};/, 'export type TestAgentInput = Partial<AgentInput> & { task: TaskSpec; workspacePath: string; cycle: number; previousReview?: ReviewerOutput; session?: import("../../src/domain/run-session.js").RunSession; };');
  content = content.replace(/export type TestAgentInput = Partial<AgentInput> & \{([^}]*)\};/g, (match, p1) => {
    if (p1.includes('session:')) return match;
    return `export type TestAgentInput = Partial<AgentInput> & { ${p1.trim()} session?: import("../../src/domain/run-session.js").RunSession; };`;
  });

  fs.writeFileSync(file, content);
}

fixFile('d:/Tan/script/PROJECT TEAM/AI TEAM V2/v1-source/tests/integration/context-isolation.test.ts');
fixFile('d:/Tan/script/PROJECT TEAM/AI TEAM V2/v1-source/tests/live/router.live.test.ts');
fixFile('d:/Tan/script/PROJECT TEAM/AI TEAM V2/v1-source/tests/unit/agents.test.ts');
