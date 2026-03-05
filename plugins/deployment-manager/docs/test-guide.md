# Deployment Manager Test Guide

## Pre-requisites

- Platform running (`./bin/start.sh --all`)
- Deployment-manager backend healthy (`curl localhost:4117/healthz`)
- Browser open at http://localhost:3000, logged in

## Automated Tests

### Running Backend Tests

```bash
cd plugins/deployment-manager/backend && npm run test:coverage
```

- 30 test files, 306 tests
- Coverage thresholds: 85% statements/branches/functions/lines
- Includes 10 BDD feature test files in `src/__tests__/bdd/`

### Running Frontend Tests

```bash
cd plugins/deployment-manager/frontend && npm run test:coverage
```

- 18 test files, 162 tests
- Coverage thresholds: 85% statements, 80% branches, 85% functions/lines

### Total: 468 tests, 48 test files

## Manual Test Cases

### TC-01: Template Listing

Navigate to Deployments → New Deployment. Verify 2 curated templates (AI Runner, Daydream Scope), Custom Docker Image option, version dropdown populates.

### TC-02: Provider Listing

Select template, click Next. Verify 6 providers listed. Verify GPU options load per provider.

### TC-03: SSH Bridge Deploy (requires SSH target)

Template → SSH Bridge → fill SSH host/port/user → Test Connection → Deploy → observe PENDING→DEPLOYING→VALIDATING→ONLINE/FAILED.

### TC-04: Serverless Deploy (requires API key)

Template → fal.ai/RunPod/Replicate → requires connector secret → Deploy → observe status.

### TC-05: Custom Template Deploy

"Custom Docker Image" → enter nginx:latest, port 80, endpoint / → select provider → deploy.

### TC-06: Health Monitoring

After ONLINE deployment → verify traffic light (GREEN=healthy, ORANGE=slow, RED=offline).

### TC-07: Deployment Lifecycle

- **Update**: change version on online → UPDATING→VALIDATING→ONLINE
- **Destroy**: destroy → DESTROYED
- **Retry**: on FAILED → retry → re-enter pipeline

### TC-08: Audit and Status

Deployment detail → Timeline tab. Audit page → action logs.

### TC-09: Version Check

After ONLINE, verify VersionBadge shows update available.

## What Can Be Tested Without Real Keys

- Template listing/version fetching (GitHub releases - public)
- Provider listing/GPU options (static in adapters)
- Wizard navigation (all 3 steps)
- Create deployment record (PENDING - in memory)
- UI components

## What Requires Real Infrastructure

- Actual deploy to fal.ai/RunPod/Replicate (needs API keys)
- SSH Bridge deploy (needs GPU machine with Docker + NVIDIA)
- Health monitoring of live deployments
- Destroy/Update on live deployments
