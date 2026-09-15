const fs = require('fs');
const file = 'tests/unit/agents.test.ts';
let code = fs.readFileSync(file, 'utf-8');

if (!code.includes('const dummySession: RunSession = {')) {
  const dummyCode = `
import { RunSession } from "../../src/domain/run-session.js";
import { ReviewEvidence } from "../../src/domain/review-evidence.js";

const dummySession: RunSession = {
  taskRunId: "run-123",
  taskId: "TASK-001",
  task: {
    id: "TASK-001",
    title: "Create a string utility module with tests",
    description: "Create src/index.js and a passing test, then run the tests.",
    acceptanceCriteria: ["the test command exits 0"],
  },
  control: { mode: "AUTO" },
  agentKeys: { coder: "coder-1", reviewer: "reviewer-1" },
  agentIds: { coder: "coder-1", reviewer: "reviewer-1" },
};

const dummyEvidence: ReviewEvidence = {
  schemaVersion: 1,
  task: dummySession.task,
  verifiedFiles: [],
  verifiedCommands: [],
  testAssessment: { passed: false, failingTestIds: [] },
  verifierLimits: []
};
`;

  code = dummyCode + code;
  code = code.replace(/\.execute\(\{/g, '.execute({ session: dummySession, reviewEvidence: dummyEvidence, ');
  fs.writeFileSync(file, code);
  console.log("Patched successfully");
} else {
  console.log("Already patched");
}
