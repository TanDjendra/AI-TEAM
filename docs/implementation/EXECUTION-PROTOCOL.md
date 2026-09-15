# AI-TEAM V2 — Execution Protocol

**Purpose:** Define standardized workflow, quality gates, and commit discipline for all development sessions.

**Version:** 1.0  
**Last Updated:** Session 02 (Phase 2 Product CLI)

---

## Development Session Lifecycle

### Before Starting Any Session

1. **Verify Base Commit**
   ```bash
   git log --oneline -10
   git show <base-commit-hash> --stat
   ```
   
2. **Check Working Tree**
   ```bash
   git status
   ```
   Must be clean or have documented uncommitted changes.

3. **Read Current State**
   - `docs/implementation/STATE.md` — Latest phase tracker
   - `docs/implementation/SESSION-XX.md` — Previous session report

4. **Review Constraints**
   - What is IN SCOPE for this session
   - What is OUT OF BOUND (STOP boundary)
   - Backward compatibility requirements

---

### During Implementation

#### Code Quality Rules

1. **Reuse First Principle**
   - Always check if existing service can solve the problem
   - Never duplicate configuration logic
   - No parallel error handling systems
   - No new model registries

2. **Windows-First Approach**
   - Use `node:path` APIs only (never bash paths)
   - No Unix-only commands (`chmod`, `sed`, etc.)
   - Cross-platform process handling
   - Test on Windows environment

3. **Secret Security**
   - Never log secret values
   - Mask secrets using `maskSecret()` before display
   - Keep `.env` authoritative for secrets
   - Backup `.env.bak` before writes

4. **TypeScript Strictness**
   - Type annotations on ALL config objects
   - No `any` types unless absolutely necessary
   - Literal types preferred (`version: 1` not `number`)
   - Pass `npm run typecheck` before testing

---

### Testing Discipline

#### Required Tests Per Session

1. **TypeScript Compilation**
   ```bash
   npm run typecheck
   ```
   Expected result: 0 errors

2. **Unit Tests**
   ```bash
   npm test
   ```
   Track baseline: Document pre-existing failures separately from new ones

3. **Integration Verification**
   - Manual test of key features
   - Verify backward compatibility with existing CLI flags
   - Test edge cases and error conditions

4. **Backward Compatibility Check**
   ```bash
   npm run task -- --check-router
   npm run task -- --check-db
   npm run worker
   npm run dev
   ```
   All must continue working without modification.

#### Failure Classification

| Failure Type | Action Required |
|--------------|-----------------|
| Pre-existing | Document, don't fix (unless in scope) |
| New regression | FIX BEFORE COMMIT |
| Environment-specific | Skip or mock appropriately |
| Type errors | Fix compilation first |

---

### Documentation Standards

#### SESSION-XX.md Template Structure

Every session MUST produce a documentation file following this pattern:

```markdown
# AI-TEAM V2 — Implementation Session XX

**Phase:** [Number] — [Name]
**Status:** COMPLETE/PARTIAL/FAILED
**Date:** [Session date]
**Model:** [AI model used]
**Base commit:** [Commit hash]

---

## Objective
[Clear statement of what this session aimed to build]

---

## Scope Delivered
| Deliverable | Location | Status |
|-------------|----------|--------|
| ... | ... | ✅ Complete |

---

## Files Changed

### Files Added
[List new files with brief description]

### Files Modified
[List modified files with rationale]

---

## Commands/Features Implemented
[Detailed descriptions of each command or feature]

---

## DEF-[XXX] Status
[Track defect repair progress]

**Problem:** [Description]
**Resolution:** [What was done]
**Evidence:** [Test results showing improvement]

---

## Backward Compatibility Verification
[Proof that existing functionality still works]

### Existing Commands Still Work
✅ Command 1 verified
✅ Command 2 verified

### Test Results
```bash
[npm test output]
```

---

## Architecture Compliance
[How implementation respects architectural principles]

### Service Reuse Matrix
| Feature | Reused Service | Module |
|---------|----------------|--------|
| ... | ... | ... |

---

## Known Limitations
[Intentional MVP choices or deferred work]

---

## Git Status
Current state before commit

---

## Next Session Plan
What will be tackled next (do NOT start it yet)
```

---

## STATE.md Updates

At end of EVERY session, update `docs/implementation/STATE.md`:

1. Update "Current phase" line
2. Mark completed phases as COMPLETE
3. Add phase deliverables table
4. Update test statistics
5. Document any open defects resolved
6. List "Next session plan" section

---

### Commit Discipline

#### Before Committing

1. **Run Full Verification**
   ```bash
   npm run verify
   ```
   
2. **Check Diff Consistency**
   ```bash
   git diff --stat
   git diff --name-status
   ```
   Verify all changed files are documented in SESSION-XX.md
   
3. **Ensure Clean Working Tree**
   ```bash
   git status --short
   ```
   Only include committed files in session scope

#### Commit Message Format

```
<type>(<scope>): <subject>

[Optional body with context]

BREAKING CHANGE: <description if applicable>
```

**Types:**
- `feat`: New functionality
- `fix`: Bug fix
- `docs`: Documentation only
- `refactor`: Code restructuring
- `chore`: Build/tooling changes
- `test`: Test additions

**Scopes:**
- `cli`: Product CLI commands
- `config`: Configuration system
- `domain`: Core domain logic
- `orchestration`: Scheduler/workflow
- `persistence`: Database layer
- `tests`: Test infrastructure

---

## STOP BOUNDARIES

### Critical Rule: DO NOT START NEXT PHASE

Even if you're near completion:

1. **Stop at the defined boundary**
2. **Document remaining work clearly**
3. **Commit current state**
4. **Wait for review before starting next phase**

This prevents:
- Scope creep within a single session
- Overcomplicating implementations
- Losing track of what was actually completed vs planned

### Stop Boundary Checklist

Before ending a session, verify:

- [ ] All scope items implemented
- [ ] All tests pass (pre-existing failures documented)
- [ ] Backward compatibility maintained
- [ ] Documentation complete
- [ ] Git status clean
- [ ] NEXT PHASE NOT STARTED

If any checkbox fails → FIX before stopping.

---

## Quality Gates

### Gate 1: TypeScript Compilation
- Must pass with 0 errors
- If any errors → cannot proceed to testing

### Gate 2: Unit Tests
- All NEW tests must pass
- Pre-existing failures documented separately
- If NEW failures appear → investigate immediately

### Gate 3: Integration Tests
- Manual verification of user-facing features
- Existing CLI flags still work
- Configuration loads correctly
- If issues found → fix before proceeding

### Gate 4: Documentation
- SESSION-XX.md complete and accurate
- STATE.md updated with latest status
- README (if applicable) reflects changes
- If missing → complete before commit

### Gate 5: Final Verification
```bash
npm run verify
git status
git diff --stat
```
All checks green → READY TO COMMIT

---

## Common Pitfalls & Solutions

### Pitfall 1: Duplicate Logic

**Symptom:** Same config validation code appears in multiple places

**Solution:** 
- Create shared utility function
- Export from common module
- Import everywhere needed

### Pitfall 2: Hardcoded Values

**Symptom:** Models/URLs hard-coded in CLI output

**Solution:**
- Trace back to source
- Remove hardcoded value
- Use existing model/profile system

### Pitfall 3: Overclaiming Features

**Symptom:** Documentation says "real health checks" but only checks config existence

**Solution:**
- Be precise about what checks are performed
- Document actual capabilities
- Don't overpromise

### Pitfall 4: Breaking Backward Compatibility

**Symptom:** Existing CLI flags stop working after changes

**Solution:**
- Review all `npm run task` flags
- Test each one explicitly
- Never modify existing CLI entry point unless required

---

## Communication Protocol

### When Reporting Issues

Use this format:

```
ISSUE REPORT

Symptom: [What happened]
Expected: [What should happen]
Actual: [What did happen]
Reproduction Steps: [How to reproduce]
Root Cause: [Analysis if known]
Impact: [Scope of problem]
Recommendation: [Suggested fix]
```

### When Seeking Clarification

Provide:
1. Context (what session, what phase)
2. Specific question (not just "I'm stuck")
3. Options considered
4. Recommendation with justification

---

## Version Tracking

### Semantic Versioning

- **Major**: Breaking API changes
- **Minor**: New features, backward compatible
- **Patch**: Bug fixes only

### Version History

```
0.1.x → Initial alpha releases
1.x.x → Stable core releases
2.x.x → Product CLI + Setup Wizard
```

Each session increments version when appropriate.

---

## File Organization

### Directory Structure

```
src/
  cli/              # All CLI entry points
    product-cli.ts  # Product CLI (Phase 2+)
    worker.ts       # Worker process
  config/           # Configuration system
    env.ts          # Environment loader
    secret-store.ts # .env management
    config-file.ts  # JSON config reader/writer
  domain/           # Core business logic
    logger.ts
    types.ts
    errors.ts
  orchestration/    # Workflow engine
  persistence/      # Database layer
  tests/            # Test suites
    unit/           # Unit tests
    integration/    # Integration tests
    e2e/            # End-to-end tests
docs/
  implementation/   # Implementation tracking
    STATE.md        # Living status document
    SESSION-XX.md   # Session reports
```

---

## Emergency Procedures

### If Tests Start Failing Unexpectedly

1. **Identify if pre-existing**
   ```bash
   git stash
   npm test
   git stash pop
   ```
   
2. **Isolate recent changes**
   ```bash
   git diff HEAD~1 src/
   ```
   
3. **Rollback if critical**
   ```bash
   git reset --soft HEAD~1
   ```
   
4. **Communicate immediately**

---

## Success Criteria

### Every Session Should Deliver

1. ✅ Functional code meeting specifications
2. ✅ Zero regressions introduced
3. ✅ Comprehensive documentation
4. ✅ Passing tests (with clear failure classification)
5. ✅ Clean git state ready to push

### Sign-Off Process

When all criteria met:

1. Author reviews own work against checklist
2. Document findings in SESSION-XX.md
3. Commit with clear message
4. Mark session as COMPLETE in STATE.md
5. **DO NOT START NEXT PHASE**

---

## Appendix A: Common Commands Cheat Sheet

```bash
# Status checks
git status
git log --oneline -10
npm run verify

# Testing
npm run typecheck
npm test
npx tsx src/cli/product-cli.ts --help

# Building
npm run build
npx tsc -p tsconfig.build.json

# Verification
git diff --stat
git diff --name-status
```

---

## Appendix B: Testing Quick Reference

### New Tests Pattern

```typescript
import { describe, it, expect, beforeEach } from "vitest";

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "test-prefix-"));
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("Feature Name", () => {
  it("handles happy path", () => {
    // Arrange
    const input = setupTestData();
    
    // Act
    const result = operate(input);
    
    // Assert
    expect(result).toBe(expectedValue);
  });

  it("handles error condition", () => {
    const input = problematicData();
    
    expect(() => operate(input)).toThrowError(Error);
  });
});
```

### Mock Pattern (when no live dependencies allowed)

```typescript
// In test file
vi.mock("../../src/module.js", () => ({
  realFunction: vi.fn().mockReturnValue(mockedValue),
  anotherExport: mockedObject,
}));
```

---

## Appendix C: Security Checklist

For every session involving user data or credentials:

- [ ] No secrets in logs
- [ ] No secrets in test outputs
- [ ] No secrets in error messages
- [ ] Secrets masked when displayed
- [ ] Backup created before modifications
- [ ] Atomic writes confirmed
- [ ] File permissions set appropriately
- [ ] No plaintext secrets in git-tracked files

---

**END OF PROTOCOL**

Use this protocol as your guide for disciplined, consistent, high-quality development sessions.
