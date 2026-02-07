# TestOrchestrator

---

This repository contains the **Test Orchestrator** service responsible for triggering and orchestrating
**test-automation runners** using **Azure Container Apps Jobs**.

The orchestrator itself runs as a **Container Apps Job**, and dynamically starts **runner job executions**
(pod-like ephemeral executions) based on a test matrix or a provided custom configuration.

---

## High-level Architecture

- **GoldenCI image**
  - Base runtime image (Node.js, OS deps, tooling)
- **RunnerCI image**
  - Built FROM GoldenCI
  - Contains the Test Orchestrator runtime code
- **Test Automation Runner image**
  - Separate project
  - Executed by Azure Container Apps Job executions
  - Receives environment variables injected by the orchestrator

---

## Project Structure

```
(root-level)
├── Setup
│   ├── GoldenCI
│   │   └── Dockerfile
│   └── RunnerCI
│       └── Dockerfile
├── src
│   ├── job
│   │   └── main.ts
│   ├── services
│   │   ├── configService.ts
│   │   ├── containerService.ts
│   │   └── orchestrationService.ts
│   └── types
│       └── index.ts
├── tests
│   ├── unit
│   ├── integration
│   └── mocks
├── package.json
├── tsconfig.json
└── README.md
```

---

## Build, Test & Run

### Install dependencies
```bash
npm install
```

### Testing
```bash
npm run test:unit
npm run test:integration
npm run test:coverage
```

### Local execution (job-style)
```bash
npm run build && node ./dist/src/job/main.js
```

---

## Docker Images

### Build
```bash
docker build -t test-orchestrator-base:latest -f Setup/GoldenCI/Dockerfile .
docker build -t test-orchestrator-runner:latest -f Setup/RunnerCI/Dockerfile .
```

### Tag & Push
```bash
docker tag test-orchestrator-base:latest test-automation.azurecr.io/test-orchestrator-base:latest
docker tag test-orchestrator-runner:latest test-automation.azurecr.io/test-orchestrator-runner:latest

docker push test-automation.azurecr.io/test-orchestrator-base:latest
docker push test-automation.azurecr.io/test-orchestrator-runner:latest
```

---

## Runtime Environment Variables

### Orchestrator Job (this service)

| Variable | Description |
|--------|-------------|
| AZURE_SUBSCRIPTION_ID | Azure subscription ID |
| RESOURCE_GROUP_NAME | Resource group containing the Container Apps Job |
| AZURE_LOCATION | Optional (default: westeurope) |
| APP_CONFIG_ENDPOINT | **Required** Azure App Configuration endpoint |
| TEST_ENVIRONMENTS | e.g. `qa,prod` |
| TEST_PLATFORMS | e.g. `web,mobile` |
| CONTAINER_IMAGE | Test Automation Runner image |
| CONTAINER_CPU | CPU per execution |
| CONTAINER_MEMORY_GB | Memory per execution |
| CONTAINERAPPS_JOB_NAME | Name of the runner job (e.g. `test-executor`) |
| ORCH_CONCURRENCY_LIMIT | Max concurrent job-start calls |

---

## Passing Environment Variables to the Test Automation Runner

The orchestrator injects environment variables into the runner execution using **one JSON variable**:

### `RUNNER_ENV_PASSTHROUGH`

```bash
RUNNER_ENV_PASSTHROUGH='{
  "REPORTS_STORAGE_ACCOUNT": "reportsstorage",
  "REPORTS_CONTAINER": "allure",
  "SUITE": "smoke",
  "PW_WORKERS": "5",
  "ENV_LABEL": "qa"
}'
```

### Injection behavior

- Parsed and validated as JSON
- Automatically injects `APP_CONFIG_ENDPOINT` if missing
- Injected into **each job execution**
- Reserved keys are controlled by orchestrator:
  - `ENV`
  - `PLATFORM`
  - `RUN_ID`
- Reserved keys are warned and ignored if provided

### Automatically injected per execution

| Variable | Source |
|--------|-------|
| ENV | Matrix env value |
| PLATFORM | Matrix platform value |
| RUN_ID | Generated per execution |

---

## Execution Model

- **One matrix cell = one job execution**
- Example:
```json
[
  {"env":"qa","platform":"web"},
  {"env":"qa","platform":"mobile"}
]
```

---

## Display `process.env` structure 
```ts
// Example: process.env inside the TestOrchestrator container at runtime
process.env = {
  // ---------------------------------------
  // Azure context (required by job/main.ts)
  // ---------------------------------------
  AZURE_SUBSCRIPTION_ID: "11111111-2222-3333-4444-555555555555",
  RESOURCE_GROUP_NAME: "RG-Automation",
  AZURE_LOCATION: "westeurope", // optional (defaults to "westeurope" if missing)

  // ---------------------------------------
  // App Config (required by ConfigService)
  // ---------------------------------------
  APP_CONFIG_ENDPOINT: "https://test-automation-config.azconfig.io",

  // ---------------------------------------
  // Matrix defaults (used when TEST_CONFIGS_JSON is missing)
  // ---------------------------------------
  TEST_ENVIRONMENTS: "qa,stage,prod",
  TEST_PLATFORMS: "web,mobile",

  // ---------------------------------------
  // Runner job & resources
  // ---------------------------------------
  CONTAINERAPPS_JOB_NAME: "test-executor",
  RUNNER_CONTAINER_NAME: "test-executor", // optional; container name inside the Job template (default: "test-executor")

  // IMPORTANT:
  // CONTAINER_IMAGE is required in your current ContainerService implementation because
  // you override the job template and must specify an image.
  CONTAINER_IMAGE: "test-automation.azurecr.io/test-automation-runner:v42",

  CONTAINER_CPU: "1.0",
  CONTAINER_MEMORY_GB: "2.0",

  // ---------------------------------------
  // Orchestrator internal behavior
  // ---------------------------------------
  ORCH_CONCURRENCY_LIMIT: "10",

  // ---------------------------------------
  // Optional: manual/custom run (overrides defaults)
  // ---------------------------------------
  // If this is present, the orchestrator runs only this matrix.
  // TEST_CONFIGS_JSON: '[{"env":"qa","platform":"web"},{"env":"qa","platform":"mobile"}]',

  // ---------------------------------------
  // Pass-through JSON (parsed by ConfigService)
  // These become env vars INSIDE each test-automation-runner execution.
  // ---------------------------------------
  RUNNER_ENV_PASSTHROUGH: JSON.stringify({
    // runner needs this to fetch config by ENV_LABEL
    // (even if you omit it here, your code auto-injects it from orchestrator APP_CONFIG_ENDPOINT)
    APP_CONFIG_ENDPOINT: "https://test-automation-config.azconfig.io",

    REPORTS_STORAGE_ACCOUNT: "test-reports",
    REPORTS_CONTAINER: "allure-reports",
    REPORTS_PREFIX: "runs",
    
    SUITE: "smoke",

    // These are injected dynamically by the orchestrator per matrix execution,
    // so you generally should NOT place them here:
    // PLATFORM: "web",
    // RUN_ID: "xxx"

    // Important for runner: it uses ENV_LABEL to select config.
    // You said ENV_LABEL should equal ENV (matrix env) => it can be overridden dynamically or set in code.
    // If you keep it here, it will be static (same for all executions).
    ENV_LABEL: "qa",

    PW_WORKERS: "5"
  }),

  // ---------------------------------------
  // Other common container runtime vars (examples)
  // ---------------------------------------
  NODE_ENV: "production",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
};
```

---

➡️ Results in **2 independent runner executions**

---

## Status

✅ Production-ready Container Apps Job orchestration  
✅ Fully unit + integration tested  
✅ Designed for scheduled and manual execution modes
