# GTM Test Suite

Fast PR-gate tests for AgentBook GTM assessment. Mocked LLM.

## Layout
- `01-bookkeeping.spec.ts` through `09-plaid.spec.ts` — workflow specs
- `helpers/` — shared utilities (login, mock LLM injection, fixture loading)
- `fixtures/llm-responses/` — canned Gemini responses keyed by (skill, user-message-hash)

## Run

    cd tests/e2e && npx playwright test gtm/ --config=playwright.config.ts

## Mock LLM strategy
The agent brain receives `callGemini` as a dependency (`ctx.callGemini` in `plugins/agentbook-core/backend/src/agent-brain.ts:28`). Tests inject a mock `callGemini` that looks up the response in `fixtures/llm-responses/`. New scenarios add fixture files; never branch the mock.
