# Deployment Manager — Architecture Documentation

## 1. Plugin Architecture Diagram (ASCII art)

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                           DEPLOYMENT MANAGER PLUGIN                                        │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │  FRONTEND (React SPA)                                                              │   │
│  │  • Dev: port 3117                                                                  │   │
│  │  • Prod: CDN bundle at /cdn/plugins/deployment-manager/                            │   │
│  │                                                                                    │   │
│  │  Pages: DeploymentWizard (3-step), DeploymentList, DeploymentDetail,               │   │
│  │         ProviderSettings, AuditPage                                                │   │
│  │                                                                                    │   │
│  │  Components: TemplateSelector, ProviderSelector, GpuConfigForm, SshHostConfig,   │   │
│  │              HealthIndicator, VersionBadge, DeploymentLogs, StatusTimeline,       │   │
│  │              AuditTable, ArtifactSelector                                          │   │
│  │                                                                                    │   │
│  │  Hooks: useDeployments, useProviders, useGpuOptions, useHealthPolling              │   │
│  └──────────────────────────────────────────────────┬──────────────────────────────┘   │
│                                                       │                                 │
│                                                       │ HTTP /api/v1/deployment-manager │
│                                                       ▼                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │  BACKEND (Express.js, port 4117)                                                 │   │
│  │                                                                                    │   │
│  │  Routes: /providers, /deployments, /templates, /health, /audit                     │   │
│  │                                                                                    │   │
│  │  Services:                                                                         │   │
│  │  • DeploymentOrchestrator — state machine (PENDING→DEPLOYING→VALIDATING→ONLINE,   │   │
│  │    with UPDATING, FAILED, DESTROYED)                                              │   │
│  │  • ProviderAdapterRegistry — Strategy pattern for provider adapters               │   │
│  │  • TemplateRegistry — curated + custom templates                                   │   │
│  │  • HealthMonitorService — periodic health polling                                  │   │
│  │  • VersionCheckerService — GitHub releases polling                                │   │
│  │  • AuditService — action logging                                                   │   │
│  │  • RateLimiter — request throttling                                                │   │
│  │                                                                                    │   │
│  │  Adapters (IProviderAdapter):                                                      │   │
│  │  FalAdapter → gw/fal-ai | RunPodAdapter → gw/runpod-serverless |                   │   │
│  │  ReplicateAdapter → gw/replicate | BasetenAdapter → gw/baseten |                    │   │
│  │  ModalAdapter → gw/modal | SshBridgeAdapter → gw/ssh-bridge                         │   │
│  └──────────────────────────────────────────────────┬──────────────────────────────┘   │
│                                                       │                                 │
│                                                       │ gwFetch → /api/v1/gw/{connector}│
│                                                       ▼                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │  SERVICE GATEWAY (Next.js middleware, port 3000)                                  │   │
│  │  • Connector resolution                                                           │   │
│  │  • Secret injection (SecretVault)                                                 │   │
│  │  • SSRF protection (allowedHosts allowlist)                                       │   │
│  │  • Circuit breaker                                                                 │   │
│  │  • Proxy to upstream Provider APIs                                                │   │
│  └──────────────────────────────────────────────────┬──────────────────────────────┘   │
│                                                       │                                 │
│                                                       ▼                                 │
│  ┌─────────────────────────────────────────────────────────────────────────────────┐   │
│  │  DATABASE (PostgreSQL, schema: plugin_deployment_manager)                          │   │
│  │  • ServerlessDeployment — deployment records                                      │   │
│  │  • DmDeploymentStatusLog — status transition log                                  │   │
│  │  • DmDeploymentAuditLog — action audit trail                                      │   │
│  │  • DmDeploymentHealthLog — health check results                                    │   │
│  │  • DmProviderAuthConfig — provider auth configs                                     │   │
│  │  • DmDeploymentTemplate — deployment templates                                     │   │
│  │                                                                                    │   │
│  │  NOTE: Orchestrator currently uses in-memory Map; Prisma integration planned.     │   │
│  └─────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                           │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

## 2. Deployment Control Flow (Mermaid sequence diagram)

```mermaid
sequenceDiagram
    actor User
    participant Frontend as Frontend (React)
    participant Backend as Backend (Express)
    participant Orchestrator as DeploymentOrchestrator
    participant Adapter as ProviderAdapter
    participant Gateway as Service Gateway
    participant Provider as Provider API (fal/runpod/etc)
    participant HealthMonitor as HealthMonitorService
    participant VersionChecker as VersionCheckerService

    %% Step 0: Template selection
    User->>Frontend: Select template in wizard (Step 0)
    Frontend->>Backend: GET /templates
    Backend-->>Frontend: templates list

    %% Step 1: Provider + GPU config
    User->>Frontend: Configure provider + GPU (Step 1)
    Frontend->>Backend: GET /providers/:slug/gpu-options
    Backend-->>Frontend: GPU options

    %% Step 2: Deploy action
    User->>Frontend: Click Deploy (Step 2)
    Frontend->>Backend: POST /deployments (create config)
    Backend->>Orchestrator: create(config)
    Orchestrator->>Orchestrator: PENDING
    Backend-->>Frontend: deployment ID

    Frontend->>Backend: POST /deployments/:id/deploy
    Backend->>Orchestrator: deploy(id)
    Orchestrator->>Orchestrator: PENDING → DEPLOYING

    Orchestrator->>Adapter: deploy(config)
    Adapter->>Gateway: gwFetch (POST to gw/{connector})
    Gateway->>Gateway: connector resolution, secret injection, SSRF check
    Gateway->>Provider: proxy request
    Provider-->>Gateway: response
    Gateway-->>Adapter: response
    Adapter-->>Orchestrator: ProviderDeployment (providerDeploymentId, endpointUrl)

    alt SSH Bridge mode
        loop poll until ONLINE/FAILED
            Orchestrator->>Adapter: getStatus(providerDeploymentId)
            Adapter->>Gateway: gwFetch
            Gateway->>Provider: proxy
            Provider-->>Adapter: status
            Adapter-->>Orchestrator: ONLINE or FAILED
        end
    end

    Orchestrator->>Orchestrator: → VALIDATING
    Orchestrator->>Adapter: healthCheck(providerDeploymentId, endpointUrl)
    Adapter->>Gateway: gwFetch (health endpoint)
    Gateway->>Provider: proxy
    Provider-->>Adapter: health response
    Adapter-->>Orchestrator: HealthResult

    alt healthy
        Orchestrator->>Orchestrator: ONLINE (GREEN)
    else unhealthy
        Orchestrator->>Orchestrator: FAILED (RED)
    end

    Orchestrator-->>Backend: DeploymentRecord
    Backend-->>Frontend: deployment

    %% Background services
    loop periodic
        HealthMonitor->>Orchestrator: list(ONLINE)
        HealthMonitor->>Adapter: healthCheck each deployment
        HealthMonitor->>Orchestrator: update healthStatus (GREEN/ORANGE/RED)
    end

    loop periodic (e.g. 30 min)
        VersionChecker->>Orchestrator: list(ONLINE)
        VersionChecker->>VersionChecker: getLatestVersion (GitHub releases)
        VersionChecker->>Orchestrator: set hasUpdate, latestAvailableVersion
    end
```

## 3. State Machine Diagram (Mermaid state diagram)

```mermaid
stateDiagram-v2
    [*] --> PENDING: create

    PENDING --> DEPLOYING: deploy
    PENDING --> DESTROYED: destroy

    DEPLOYING --> VALIDATING: deployed (adapter returns)
    DEPLOYING --> FAILED: error

    VALIDATING --> ONLINE: healthy (healthCheck OK)
    VALIDATING --> FAILED: unhealthy (healthCheck fails)

    ONLINE --> UPDATING: update
    ONLINE --> DESTROYED: destroy

    UPDATING --> VALIDATING: updated (adapter returns)
    UPDATING --> FAILED: error

    FAILED --> DEPLOYING: retry
    FAILED --> DESTROYED: destroy

    DESTROYED --> [*]
```

**Valid transitions (from code):**

| From      | To                                  |
|-----------|-------------------------------------|
| PENDING   | DEPLOYING, DESTROYED                |
| DEPLOYING | VALIDATING, FAILED                  |
| VALIDATING| ONLINE, FAILED                     |
| ONLINE    | UPDATING, DESTROYED                 |
| UPDATING  | VALIDATING, FAILED                  |
| FAILED    | DEPLOYING, DESTROYED                |
| DESTROYED | (terminal)                          |

## 4. Service Dependency Graph

```
                    ┌───────────────────────────────┐
                    │  ProviderAdapterRegistry      │
                    │  (Strategy pattern)           │
                    └───────────────┬───────────────┘
                                    │
            ┌───────────────────────┼───────────────────────┐
            │                       │                       │
            ▼                       ▼                       ▼
┌───────────────────────┐ ┌───────────────────────┐ ┌─────────────────────┐
│ DeploymentOrchestrator │ │ HealthMonitorService   │ │ Routes: /providers   │
│ (state machine)        │◄│ (periodic polling)     │ │ /providers/:slug/   │
└───────────┬───────────┘ └───────────┬───────────┘ │ gpu-options          │
            │                           │
            │  uses registry.get(slug)  │
            │  for healthCheck          │
            │                           │
            ├───────────────────────────┼───────────────────────────────────┐
            │                           │                                   │
            ▼                           ▼                                   ▼
┌───────────────────┐     ┌───────────────────┐               ┌───────────────────┐
│ AuditService       │     │ TemplateRegistry  │               │ Routes:            │
│ (action log)       │     │ (curated+custom)  │               │ /deployments       │
└───────────────────┘     └─────────┬─────────┘               │ /templates         │
                                    │                          │ /health            │
                                    │                          │ /audit             │
                                    ▼                          └───────────────────┘
                        ┌───────────────────────┐
                        │ VersionCheckerService │
                        │ (GitHub releases)     │
                        └───────────┬───────────┘
                                    │
                                    │ depends on: orchestrator, templateRegistry
                        ┌───────────┴───────────┐
                        │ GithubReleasesAdapter │
                        │ → gw/github-releases  │
                        └───────────────────────┘
```

**Dependency summary:**

| Service                 | Depends on                                              |
|-------------------------|---------------------------------------------------------|
| DeploymentOrchestrator  | ProviderAdapterRegistry, AuditService                   |
| HealthMonitorService    | ProviderAdapterRegistry, DeploymentOrchestrator         |
| VersionCheckerService   | DeploymentOrchestrator, TemplateRegistry                |
| TemplateRegistry        | GithubReleasesAdapter (internal)                         |
| AuditService            | (none — standalone)                                     |
| RateLimiter             | (none — used by deployments router)                    |
| Routes /deployments     | DeploymentOrchestrator, RateLimiter                     |
| Routes /providers       | ProviderAdapterRegistry                                 |
| Routes /templates       | TemplateRegistry                                        |
| Routes /health          | HealthMonitorService, DeploymentOrchestrator             |
| Routes /audit           | AuditService                                            |
