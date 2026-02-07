import { ContainerService } from "../../../src/services/containerService";
import {
    createCapturingLogger,
    createMockContainerAppsApiClient,
    mockAzureConfig,
} from "../../mocks/azureMocks";
import { TestConfig } from "../../../src/types";

/**
 * ContainerService unit tests (Container Apps Jobs)
 * -------------------------------------------------
 * These tests validate ContainerService behavior after migrating from:
 *   ACI container groups  -->  Container Apps Jobs executions
 *
 * What we mock:
 * - @azure/arm-appcontainers: ContainerAppsAPIClient constructor
 * - client.jobs.beginStartAndWait: "start execution" API call
 *
 * What we assert:
 * - Correct (rg, jobName, payload) are passed to beginStartAndWait(...)
 * - Dynamic env vars are injected per execution:
 *     ENV, ENV_LABEL, PLATFORM, RUN_ID
 * - CPU/memory are translated correctly (Gi format)
 * - Image is required when overriding the template.containers payload
 * - Errors are handled gracefully and returned as structured results
 *
 * Notes:
 * - RUN_ID is generated dynamically; we assert it exists and is a string.
 */
// Mock Azure SDK modules used by ContainerService
jest.mock("@azure/arm-appcontainers");
jest.mock("@azure/identity");



describe("ContainerService (Container Apps Jobs)", () => {
    let containerService: ContainerService;
    let mockClient: any;
    let logger: ReturnType<typeof createCapturingLogger>;

    beforeEach(() => {
        mockClient = createMockContainerAppsApiClient();
        logger = createCapturingLogger();

        // Mock the ContainerAppsAPIClient constructor to return our mocked client instance
        const { ContainerAppsAPIClient } = require("@azure/arm-appcontainers");
        ContainerAppsAPIClient.mockImplementation(() => mockClient);

        containerService = new ContainerService(mockAzureConfig as any);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe("startTestExecution", () => {
        const jobName = "test-orchestrator-job";
        const testConfig: TestConfig = { env: "prod", platform: "web" };

        it("should start an execution successfully (with image override) and inject dynamic env vars", async () => {
            const containerConfig = {
                image: "test.azurecr.io/test:latest",
                cpu: 1.0,
                memoryGB: 1.5,
                // Static runner env passthrough map (from RUNNER_ENV_PASSTHROUGH JSON)
                runnerEnv: {
                    APP_CONFIG_ENDPOINT: "https://example.appconfig.io",
                    PW_WORKERS: "5",
                },
            };

            const result = await containerService.startTestExecution(
                jobName,
                testConfig,
                containerConfig as any,
                logger
            );

            expect(result.success).toBe(true);
            expect(result.jobName).toBe(jobName);
            expect(result.config).toEqual(testConfig);
            expect(result.executionName).toBe("exec-test-001");

            expect(mockClient.jobs.beginStartAndWait).toHaveBeenCalledTimes(1);

            const [rgArg, jobArg, payloadArg] =
                mockClient.jobs.beginStartAndWait.mock.calls[0];

            // Validates correct resource group + job target
            expect(rgArg).toBe(mockAzureConfig.resourceGroup);
            expect(jobArg).toBe(jobName);

            // Validate payload structure (template override)
            const container = payloadArg.template.containers[0];
            expect(container.name).toBe("test-executor");

            // Image override should be included when provided
            expect(container.image).toBe(containerConfig.image);

            // Resource translation
            expect(container.resources.cpu).toBe(1.0);
            expect(container.resources.memory).toBe("1.5Gi");

            // Dynamic env injection (per execution)
            expect(container.env).toContainEqual({ name: "ENV", value: "prod" });
            expect(container.env).toContainEqual({ name: "ENV_LABEL", value: "prod" }); // alias required by runner
            expect(container.env).toContainEqual({ name: "PLATFORM", value: "web" });

            // RUN_ID is generated dynamically (UUID string). We only assert presence/type.
            const runIdEntry = (container.env as Array<{ name: string; value: string }>).find(
                (e) => e.name === "RUN_ID"
            );
            expect(runIdEntry).toBeTruthy();
            expect(runIdEntry!.value).toEqual(expect.any(String));

            // Static passthrough env vars should be appended
            expect(container.env).toContainEqual({
                name: "APP_CONFIG_ENDPOINT",
                value: "https://example.appconfig.io",
            });
            expect(container.env).toContainEqual({ name: "PW_WORKERS", value: "5" });
        });

        it("should start an execution and warn+ignore reserved keys found in runnerEnv passthrough", async () => {
            const containerConfig = {
                image: "test.azurecr.io/test:latest",
                cpu: 1.0,
                memoryGB: 1.0,
                runnerEnv: {
                    // These must be ignored (reserved)
                    ENV: "hijack-env",
                    ENV_LABEL: "hijack-label",
                    PLATFORM: "hijack-platform",
                    RUN_ID: "hijack-runid",
                    // This should pass through
                    SUITE: "smoke",
                },
            };

            await containerService.startTestExecution(
                jobName,
                testConfig,
                containerConfig as any,
                logger
            );

            const payloadArg = mockClient.jobs.beginStartAndWait.mock.calls[0][2];
            const container = payloadArg.template.containers[0];

            // The injected dynamic values should remain correct
            expect(container.env).toContainEqual({ name: "ENV", value: "prod" });
            expect(container.env).toContainEqual({ name: "ENV_LABEL", value: "prod" });
            expect(container.env).toContainEqual({ name: "PLATFORM", value: "web" });

            // The hijack values should NOT appear
            expect(container.env).not.toContainEqual({ name: "ENV", value: "hijack-env" });
            expect(container.env).not.toContainEqual({ name: "ENV_LABEL", value: "hijack-label" });
            expect(container.env).not.toContainEqual({ name: "PLATFORM", value: "hijack-platform" });
            expect(container.env).not.toContainEqual({ name: "RUN_ID", value: "hijack-runid" });

            // Non-reserved key should still be passed
            expect(container.env).toContainEqual({ name: "SUITE", value: "smoke" });

            // Ensure warnings were emitted for reserved keys
            expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/reserved key 'ENV'/i));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/reserved key 'ENV_LABEL'/i));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/reserved key 'PLATFORM'/i));
            expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/reserved key 'RUN_ID'/i));
        });

        it("should clamp very small memory to a safe minimum", async () => {
            const containerConfig = {
                image: "test.azurecr.io/test:latest",
                cpu: 1.0,
                memoryGB: 0,
            };

            await containerService.startTestExecution(
                jobName,
                testConfig,
                containerConfig as any,
                logger
            );

            const payloadArg = mockClient.jobs.beginStartAndWait.mock.calls[0][2];
            const container = payloadArg.template.containers[0];

            // ContainerService enforces a minimum of 0.25Gi
            expect(container.resources.memory).toBe("0.25Gi");
        });

        it("should handle start execution failure gracefully", async () => {
            mockClient.jobs.beginStartAndWait.mockRejectedValueOnce(
                new Error("Start failed")
            );

            const containerConfig = {
                image: "test.azurecr.io/test:latest",
                cpu: 1.0,
                memoryGB: 1.5,
            };

            const result = await containerService.startTestExecution(
                jobName,
                testConfig,
                containerConfig as any,
                logger
            );

            expect(result.success).toBe(false);
            expect(result.jobName).toBe(jobName);
            expect(result.config).toEqual(testConfig);
            expect(result.error).toBe("Start failed");
        });

        it("should fail fast when runner image is missing (template override requires image)", async () => {
            const containerConfig = {
                // image intentionally missing
                cpu: 2.0,
                memoryGB: 2,
            };

            const result = await containerService.startTestExecution(
                jobName,
                testConfig,
                containerConfig as any,
                logger
            );

            expect(result.success).toBe(false);
            expect(result.error).toMatch(/Missing runner image/i);
            expect(mockClient.jobs.beginStartAndWait).not.toHaveBeenCalled();
        });
    });
});
