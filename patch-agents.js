const fs = require('fs');
const file = 'tests/unit/agents.test.ts';
let code = fs.readFileSync(file, 'utf-8');

const importsToAdd = 'import { RunSession } from "../../src/domain/run-session.js";\nimport { ReviewEvidence } from "../../src/domain/review-evidence.js";\n';
if (!code.includes('RunSession')) {
  code = code.replace(/import \{ Workspace \} from .*/, match => match + '\n' + importsToAdd);
}

const dummySessionCode = `
const dummySession: RunSession = {
  taskRunId: "run-123",
  taskId: "TASK-001",
  task: TASK,
  control: { mode: "AUTO" },
  agentKeys: { coder: "coder-1", reviewer: "reviewer-1" },
  agentIds: { coder: "coder-1", reviewer: "reviewer-1" },
};

const dummyEvidence: ReviewEvidence = {
  schemaVersion: 1,
  task: TASK,
  verifiedFiles: [],
  verifiedCommands: [],
  testAssessment: { passed: false, failingTestIds: [] },
  verifierLimits: []
};
`;

if (!code.includes('const dummySession')) {
  code = code.replace(/const TASK: TaskSpec = \{[\s\S]*?\};/, match => match + '\n' + dummySessionCode);
}

code = code.replace(/\.execute\(\{/g, '.execute({ session: dummySession, reviewEvidence: dummyEvidence, ');

fs.writeFileSync(file, code);
