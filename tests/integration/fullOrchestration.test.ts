import { OrchestrationService } from "../../src/services/orchestrationService";
import { ContainerService } from "../../src/services/containerService";
import { ConfigService } from "../../src/services/configService";
import {
    createCapturingLogger,
    createMockContainerAppsApiClient,
    mockAzureConfig,
} from "../mocks/azureMocks";


// Integration test for the "real" OrchestrationService + ConfigService + ContainerService wiring,
// while mocking only the Azure SDK client calls.
//
// Validates end-to-end behavior:
// - ConfigService builds a matrix from env vars
// - ConfigService builds container config (resources + runnerEnv passthrough map)
// - OrchestrationService resolves job name + concurrency limit and starts executions
// - ContainerService sends correct ARM payload to jobs.beginStartAndWait(...)
// - Dynamic env injection is present: ENV, ENV_LABEL, PLATFORM, RUN_ID
// - Optional runner env passthrough values are injected
//
// Notes:
// - We do NOT wait for the test-runner to finish. beginStartAndWait only waits for ARM "start" completion.
// ContainerService uses Container Apps SDK
jest.mock("@azure/arm-appcontainers");
jest.mock("@azure/identity");

describe("Full Orchestration Integration (Container Apps Jobs)", () => {
    let orchestrationService: OrchestrationService;
    let mockClient: any;

    beforeEach(() => {
        // Deterministic defaults: 2 envs x 2 platforms = 4 executions
        process.env.TEST_ENVIRONMENTS = "prod,qa";
        process.env.TEST_PLATFORMS = "web,mobile";

        // Container resources + image (required by ContainerService when overriding template.containers)
        process.env.CONTAINER_IMAGE = "test.azurecr.io/test:latest";
        process.env.CONTAINER_CPU = "1.0";
        process.env.CONTAINER_MEMORY_GB = "2.0";

        // Required: job name for start
        process.env.CONTAINERAPPS_JOB_NAME = "test-orchestrator-job";

        // Optional: concurrency (default is 10)
        process.env.ORCH_CONCURRENCY_LIMIT = "10";

        // Optional: runner env passthrough JSON map
        // (ConfigService parses it and passes to ContainerService which injects env vars into execution)
        process.env.RUNNER_ENV_PASSTHROUGH = JSON.stringify({
            APP_CONFIG_ENDPOINT: "https://example.appconfig.io",
            REPORTS_CONTAINER: "allure",
            PW_WORKERS: "5",
        });

        // Mock Azure SDK client used by ContainerService
        mockClient = createMockContainerAppsApiClient();
        const { ContainerAppsAPIClient } = require("@azure/arm-appcontainers");
        ContainerAppsAPIClient.mockImplementation(() => mockClient);

        // Real services (Azure SDK is mocked)
        const containerService = new ContainerService(mockAzureConfig as any);
        const configService = new ConfigService();
        orchestrationService = new OrchestrationService(containerService, configService);
    });

    afterEach(() => {
        jest.clearAllMocks();
        delete process.env.TEST_ENVIRONMENTS;
        delete process.env.TEST_PLATFORMS;
        delete process.env.CONTAINER_IMAGE;
        delete process.env.CONTAINER_CPU;
        delete process.env.CONTAINER_MEMORY_GB;
        delete process.env.CONTAINERAPPS_JOB_NAME;
        delete process.env.ORCH_CONCURRENCY_LIMIT;
        delete process.env.RUNNER_ENV_PASSTHROUGH;
    });

    it(
        "should orchestrate full job execution start flow",
        async () => {
            const logger = createCapturingLogger();

            const result = await orchestrationService.executeTests(undefined, logger);

            expect(result).toBeDefined();
            expect(result.totalExecutions).toBe(4);
            expect(result.executions).toHaveLength(4);
            expect(result.timestamp).toBeDefined();

            expect(mockClient.jobs.beginStartAndWait).toHaveBeenCalledTimes(4);

            // Spot-check one payload for correctness
            const payloadArg = mockClient.jobs.beginStartAndWait.mock.calls[0][2];
            const container = payloadArg.template.containers[0];

            expect(container.name).toBe("test-executor");
            expect(container.image).toBe("test.azurecr.io/test:latest");
            expect(container.resources.cpu).toBe(1.0);
            expect(container.resources.memory).toBe("2Gi");

            // Dynamic env injection must be present
            expect(container.env).toEqual(
                expect.arrayContaining([
                    { name: "ENV", value: expect.any(String) },
                    { name: "ENV_LABEL", value: expect.any(String) },
                    { name: "PLATFORM", value: expect.any(String) },
                    { name: "RUN_ID", value: expect.any(String) },
                ])
            );

            // Static passthrough values must be present
            expect(container.env).toEqual(
                expect.arrayContaining([
                    { name: "APP_CONFIG_ENDPOINT", value: "https://example.appconfig.io" },
                    { name: "REPORTS_CONTAINER", value: "allure" },
                    { name: "PW_WORKERS", value: "5" },
                ])
            );

            const logs = logger._getLogs();
            expect(logs.some((l) => l.includes("Test Execution Started"))).toBe(true);
            expect(logs.some((l) => l.includes("Job Execution Start Phase"))).toBe(true);
            expect(logs.some((l) => l.includes("Orchestration completed"))).toBe(true);
        },
        30000
    );

    it("should handle custom test configurations", async () => {
        const logger = createCapturingLogger();

        const customConfigs = [
            { env: "qa", platform: "web" },
            { env: "prod", platform: "mobile" },
        ];

        const result = await orchestrationService.executeTests(customConfigs as any, logger);

        expect(result.totalExecutions).toBe(2);
        expect(result.executions).toHaveLength(2);
        expect(mockClient.jobs.beginStartAndWait).toHaveBeenCalledTimes(2);

        // Ensure we are not accidentally using default matrix here:
        // Each start call should have jobName args correct and payload shaped.
        for (const call of mockClient.jobs.beginStartAndWait.mock.calls) {
            expect(call[0]).toBe(mockAzureConfig.resourceGroup);
            expect(call[1]).toBe("test-orchestrator-job");
        }
    });
});