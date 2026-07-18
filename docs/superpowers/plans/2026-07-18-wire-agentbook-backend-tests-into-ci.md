# Wire AgentBook Backend Tests Into CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI actually run the ~41 existing backend test files for `agentbook-core`, `agentbook-invoice`, `agentbook-expense`, `agentbook-tax`, `agentbook-startup`, and `packages/agentbook-jurisdictions` — today none of them are enforced by any CI job. PR #241 (already merged) fixed the `plugin-tests`/`sdk-compat-matrix` jobs' plugin list, but those two jobs only run each plugin's **frontend** tests (`cd plugins/<name>/frontend && npm test`) — the backend directories (and the standalone `agentbook-jurisdictions` package) are still completely unenforced.

**Architecture:** Add one new `backend-tests` matrix job to `.github/workflows/ci.yml`, mirroring `plugin-tests`'s exact structure (matrix strategy, per-plugin changed-file gating, checkout/setup/install/test steps) but pointed at each plugin's `backend/` directory plus `packages/agentbook-jurisdictions` (which isn't under `plugins/` at all, so needs its own matrix entry with a different path). Every target already has a working `"test": "vitest run"` script — this is pure CI wiring, no new test-writing.

**Tech Stack:** GitHub Actions, Vitest.

## Global Constraints

- No new test files, no changes to existing test logic — every target already has a real `test` script; this PR only makes CI run it.
- Match `plugin-tests`'s existing structure exactly (per-plugin changed-file gate, `--if-present` where relevant, same checkout/setup/install steps) rather than inventing a different CI pattern.
- Don't touch `plugin-tests`/`sdk-compat-matrix` (frontend jobs) or any other existing job — this is purely additive.
- `quality-gates` (the final pass/fail aggregator) must be updated to require this new job too — otherwise a red `backend-tests` run wouldn't actually block anything.

---

### Task 1: Add the `backend-tests` CI job

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a new `backend-tests` job whose result feeds into `quality-gates`'s existing upstream-results check.

- [ ] **Step 1: Read `.github/workflows/ci.yml` in full** — specifically the `paths-filter`, `plugin-tests`, and `quality-gates` jobs — to confirm the exact current structure before adding anything (this plan's snippets are a template; match the real current YAML, not an assumed shape).

- [ ] **Step 2: Add the new job**, placed after `plugin-tests` and before `lifecycle-tests`:

```yaml
  # ===========================================================================
  # Backend Tests — AgentBook plugin backends + jurisdiction packages
  # ===========================================================================
  backend-tests:
    name: Backend Tests — ${{ matrix.target }}
    runs-on: ubuntu-latest
    needs: [paths-filter, lockfile-sync]
    if: needs.paths-filter.outputs.plugins == 'true' || needs.paths-filter.outputs.packages == 'true'
    strategy:
      fail-fast: false
      matrix:
        include:
          - target: agentbook-core
            path: plugins/agentbook-core/backend
          - target: agentbook-invoice
            path: plugins/agentbook-invoice/backend
          - target: agentbook-expense
            path: plugins/agentbook-expense/backend
          - target: agentbook-tax
            path: plugins/agentbook-tax/backend
          - target: agentbook-startup
            path: plugins/agentbook-startup/backend
          - target: agentbook-jurisdictions
            path: packages/agentbook-jurisdictions
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: Check if target changed
        id: check
        run: |
          CHANGED=$(git diff --name-only ${{ github.event.pull_request.base.sha || 'HEAD~1' }} HEAD -- "${{ matrix.path }}/")
          if [ -n "$CHANGED" ]; then
            echo "changed=true" >> $GITHUB_OUTPUT
            echo "${{ matrix.target }} has changes:"
            echo "$CHANGED"
          else
            echo "changed=false" >> $GITHUB_OUTPUT
            echo "${{ matrix.target }} has no changes — skipping"
          fi

      - name: Setup Node.js
        if: steps.check.outputs.changed == 'true'
        uses: actions/setup-node@v6
        with:
          node-version: ${{ env.NODE_VERSION }}
          cache: 'npm'

      - name: Install dependencies
        if: steps.check.outputs.changed == 'true'
        run: npm ci

      - name: Run backend tests
        if: steps.check.outputs.changed == 'true'
        run: |
          cd ${{ matrix.path }}
          npm test --if-present
```

Verify the exact `env.NODE_VERSION` variable name and the checkout/setup-node/install step shapes match what `plugin-tests` actually uses (read it first, per Step 1) — copy that job's real syntax rather than the snippet above if there's any difference (e.g. action version pins, cache config).

- [ ] **Step 3: Wire `backend-tests` into `quality-gates`** — read the `quality-gates` job's `needs:` list and its upstream-results check script in full, then add `backend-tests` to both: the `needs:` array, and the pass/fail check logic (mirroring exactly how `plugin-tests`/`shell-tests`/etc. are already checked there).

- [ ] **Step 4: Verify locally** — since GitHub Actions workflow files can't be run as unit tests, do the equivalent by hand: `cd plugins/agentbook-core/backend && npm test`, `cd plugins/agentbook-invoice/backend && npm test`, `cd plugins/agentbook-expense/backend && npm test`, `cd plugins/agentbook-tax/backend && npm test`, `cd plugins/agentbook-startup/backend && npm test`, `cd packages/agentbook-jurisdictions && npm test` — confirm every single one runs and reports a real pass/fail result (not "no test script found"), and note the pass/fail counts (some may have known pre-existing failures — that's fine, note them, don't try to fix unrelated pre-existing test failures as part of this PR).

- [ ] **Step 5: Validate the YAML syntax** — run `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` (or an equivalent YAML linter available in this environment) to catch indentation/syntax errors before committing, since there's no way to fully dry-run a GitHub Actions workflow locally.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "feat(ci): wire AgentBook backend + jurisdiction-package tests into CI

Closes the launch-readiness audit's top CI-coverage finding: ~41
backend test files across 5 plugin backends and the jurisdictions
package had zero automated enforcement. PR #241 wired frontend
plugin tests; this adds the matching backend job."
```

## Self-Review

- Spec coverage: this closes the roadmap's PR US-6 entry exactly as originally scoped (the part PR #241 didn't cover) — agentbook-core/invoice/expense/tax/startup backends + agentbook-jurisdictions, all wired into a real CI gate.
- Placeholder scan: none — every step is either real YAML or a real verification command.
- Note: this PR does NOT fix any pre-existing backend test failures it might newly surface in CI (that's out of scope — flagging any found failures for a follow-up is correct; silently skipping the whole job to avoid seeing them is not).
