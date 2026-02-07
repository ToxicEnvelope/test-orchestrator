import { OrchestrationService } from "../../../src/services/orchestrationService";
import { ContainerService } from "../../../src/services/containerService";
import { ConfigService } from "../../../src/services/configService";
import { createCapturingLogger } from "../../mocks/azureMocks";
import { TestConfig } from "../../../src/types";

/**
 * OrchestrationService unit tests (Container Apps Jobs)
 * ----------------------------------------------------
 * Validates:
 * - Default path (uses ConfigService.getTestMatrix())
 * - Reads container config (cpu/memory/image/network intent + runnerEnv passthrough)
 * - Resolves job name (Container Apps Job) before starting
 * - Applies concurrency limit (default 10)
 * - Calls ContainerService.startTestExecution(jobName, config, containerConfig, logger) for each config
 * - Produces a proper summary response (success/failure counts + message)
 *
 * Note:
 * - Logger now supports warn/log/error (ContainerService and friends may emit warn-level events).
 */
describe("OrchestrationService (Container Apps Jobs)", () => {
    let mockContainerService: jest.Mocked<ContainerService>;
    let mockConfigService: jest.Mocked<ConfigService>;
    let service: OrchestrationService;
    let logger: ReturnType<typeof createCapturingLogger>;

    beforeEach(() => {
        logger = createCapturingLogger();

        // Create typed mocks
        mockContainerService = {
            startTestExecution: jest.fn(),
        } as any;

        mockConfigService = {
            getTestMatrix: jest.fn(),
            getContainerConfig: jest.fn(),
            getContainerAppsJobName: jest.fn(),
            getConcurrencyLimit: jest.fn(),
        } as any;

        service = new OrchestrationService(mockContainerService, mockConfigService);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it("should execute tests using defaults and start executions for each config", async () => {
        const matrix: TestConfig[] = [
            { env: "prod", platform: "web" },
            { env: "prod", platform: "mobile" },
            { env: "qa", platform: "web" },
        ];

        const containerConfig = {
            image: "test-automation.azurecr.io/test-orchestrator-runner:latest",
            cpu: 1.0,
            memoryGB: 1.5,
            network: {
                enabled: true,
                vnetName: "Test-Automation-Resources-vnets",
            },
            runnerEnv: {
                APP_CONFIG_ENDPOINT: "https://example.appconfig.io",
                REPORTS_CONTAINER: "allure",
                PW_WORKERS: "5",
            },
        };

        mockConfigService.getTestMatrix.mockResolvedValue(matrix);
        mockConfigService.getContainerConfig.mockResolvedValue(containerConfig as any);
        mockConfigService.getContainerAppsJobName.mockResolvedValue("test-orchestrator-job");

        // Default 10 everywhere
        mockConfigService.getConcurrencyLimit.mockResolvedValue(10);

        // Make ContainerService succeed for all starts
        mockContainerService.startTestExecution.mockImplementation(
            async (jobName: string, cfg: TestConfig) =>
                ({
                    jobName,
                    executionName: `exec-${cfg.env}-${cfg.platform}`,
                    config: cfg,
                    success: true,
                    startedAt: new Date().toISOString(),
                } as any)
        );

        const response = await service.executeTests(undefined, logger);

        // ConfigService methods invoked
        expect(mockConfigService.getTestMatrix).toHaveBeenCalledTimes(1);
        expect(mockConfigService.getContainerConfig).toHaveBeenCalledTimes(1);
        expect(mockConfigService.getContainerAppsJobName).toHaveBeenCalledTimes(1);

        // Best practice: ensure default is passed in (OrchestrationService requests default=10)
        expect(mockConfigService.getConcurrencyLimit).toHaveBeenCalledWith();

        // Start called for each config
        expect(mockContainerService.startTestExecution).toHaveBeenCalledTimes(matrix.length);

        for (const cfg of matrix) {
            expect(mockContainerService.startTestExecution).toHaveBeenCalledWith(
                "test-orchestrator-job",
                cfg,
                containerConfig,
                logger
            );
        }

        // Response summary
        expect(response.totalExecutions).toBe(3);
        expect(response.successful).toBe(3);
        expect(response.failed).toBe(0);
        expect(response.success).toBe(true);
    });

    it("should use provided configs (not call getTestMatrix)", async () => {
        const provided: TestConfig[] = [{ env: "stage", platform: "web" }];

        const containerConfig = {
            image: "test-automation.azurecr.io/test-orchestrator-runner:latest",
            cpu: 1.0,
            memoryGB: 1.5,
            runnerEnv: {
                SUITE: "smoke",
            },
        };

        mockConfigService.getContainerConfig.mockResolvedValue(containerConfig as any);
        mockConfigService.getContainerAppsJobName.mockResolvedValue("test-orchestrator-job");
        mockConfigService.getConcurrencyLimit.mockResolvedValue(10);

        mockContainerService.startTestExecution.mockResolvedValue({
            jobName: "test-orchestrator-job",
            executionName: "exec-stage-web",
            config: provided[0],
            success: true,
        } as any);

        const response = await service.executeTests(provided, logger);

        expect(mockConfigService.getTestMatrix).not.toHaveBeenCalled();
        expect(mockContainerService.startTestExecution).toHaveBeenCalledTimes(1);

        expect(mockContainerService.startTestExecution).toHaveBeenCalledWith(
            "test-orchestrator-job",
            provided[0],
            containerConfig,
            logger
        );

        expect(response.totalExecutions).toBe(1);
        expect(response.success).toBe(true);
    });

    it("should mark failures in summary if startTestExecution returns failure", async () => {
        const matrix: TestConfig[] = [
            { env: "prod", platform: "web" },
            { env: "qa", platform: "mobile" },
        ];

        const containerConfig = {
            image: "test-automation.azurecr.io/test-orchestrator-runner:latest",
            cpu: 1.0,
            memoryGB: 1.5,
        };

        mockConfigService.getTestMatrix.mockResolvedValue(matrix);
        mockConfigService.getContainerConfig.mockResolvedValue(containerConfig as any);
        mockConfigService.getContainerAppsJobName.mockResolvedValue("test-orchestrator-job");
        mockConfigService.getConcurrencyLimit.mockResolvedValue(10);

        mockContainerService.startTestExecution.mockImplementation(
            async (jobName: string, cfg: TestConfig) => {
                if (cfg.env === "qa") {
                    return {
                        jobName,
                        executionName: "unknown",
                        config: cfg,
                        success: false,
                        error: "Start failed",
                    } as any;
                }
                return {
                    jobName,
                    executionName: "exec-ok",
                    config: cfg,
                    success: true,
                } as any;
            }
        );

        const response = await service.executeTests(undefined, logger);

        expect(response.totalExecutions).toBe(2);
        expect(response.successful).toBe(1);
        expect(response.failed).toBe(1);
        expect(response.success).toBe(false);
        expect(response.message).toContain("1 execution(s) failed");
    });
});

