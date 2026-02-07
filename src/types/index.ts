/**
 * A single test execution configuration (one matrix cell).
 * Example: { env: "qa", platform: "web" }
 */
export interface TestConfig {
    env: string;
    platform: string;
    timeout?: number;
    retries?: number;
    tags?: string[];
    parallelism?: number;
}

/**
 * Network configuration (intent / logging).
 *
 * IMPORTANT:
 * In Azure Container Apps, VNet integration is configured on the *Container Apps Environment*.
 * Jobs and executions inherit that environment network configuration.
 *
 * We keep this model mainly for validation/logging and consistency with your design requirements.
 */
export interface VNetConfig {
    enabled: boolean;

    /**
     * Default VNet name you want to associate with executions.
     * Your requirement: "Isrotel-Automation-Resources-vnets"
     */
    vnetName: string;

    /**
     * Optional: Subnet resource ID used by the Container Apps Environment.
     * Example:
     * /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.Network/virtualNetworks/<vnet>/subnets/<subnet>
     */
    subnetResourceId?: string;

    /** Optional hints */
    subnetName?: string;

    /** If using internal-only Container Apps Environment / private endpoints */
    internalOnly?: boolean;
}

/**
 * Runtime configuration used when starting a runner execution.
 *
 * Notes:
 * - For Container Apps Jobs, the image is typically set on the Job definition.
 *   We keep `image` optional so the orchestrator can override it if needed.
 * - `runnerEnv` is where we inject additional environment variables into the runner “pod”.
 */
export interface ContainerConfig {
    image?: string;
    cpu: number;
    memoryGB: number;

    /**
     * Network intent / logging information.
     * If you always run on the same environment/VNet, you can set:
     *  network: { enabled: true, vnetName: "Isrotel-Automation-Resources-vnets" }
     */
    network?: VNetConfig;

    /**
     * Extra environment variables to pass into the Test Automation runner execution.
     *
     * This enables your “pipe env vars into the runner image” requirement:
     * - Orchestrator reads env vars (e.g. from its own environment)
     * - Constructs this map
     * - Injects these into the runner execution template alongside ENV/PLATFORM
     *
     * Example:
     *  runnerEnv: {
     *    "PW_WORKERS": "5",
     *    "ALLURE_ENDPOINT": "https://...",
     *    "MY_FEATURE_FLAG": "true"
     *  }
     */
    runnerEnv?: Record<string, string>;
}

/**
 * Azure context used by services that call ARM (Container Apps management).
 */
export interface AzureConfig {
    subscriptionId: string;
    resourceGroup: string;
    /**
     * Optional location for logs/validation.
     * Your default behavior: "westeurope" when AZURE_LOCATION is not set.
     */
    location?: string;
}

/**
 * Result of starting a runner execution for one TestConfig.
 */
export interface JobExecutionResult {
    jobName: string;
    executionName: string;
    config: TestConfig;
    success: boolean;
    error?: string;

    executionId?: string;
    startedAt?: string;
}

/**
 * Legacy request payload shape (used when this project was triggered via HTTP).
 * Keeping it is harmless and can still be useful for tooling.
 */
export interface TestExecutionRequest {
    testConfigs?: TestConfig[];
    useDefaults?: boolean;
}

/**
 * Orchestration response (executions started).
 */
export interface TestExecutionResponse {
    success: boolean;
    message: string;
    totalExecutions: number;
    successful: number;
    failed: number;
    executions: JobExecutionResult[];
    timestamp: string;
}