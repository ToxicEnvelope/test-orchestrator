"use strict";
/**
 * ContainerService (Azure Container Apps Jobs)
 * --------------------------------------------
 * Responsible for starting a new *execution* of an existing Container Apps Job.
 *
 * Think of an execution as a "pod-like" ephemeral replica:
 * - the runner container starts
 * - runs tests
 * - exits
 *
 * This service:
 * - calls ARM via @azure/arm-appcontainers
 * - uses DefaultAzureCredential for auth (Managed Identity / env credentials)
 * - injects ENV + PLATFORM per matrix cell
 * - optionally injects additional runner environment variables (runnerEnv passthrough)
 *
 * Important implementation detail:
 * - We override the Job execution template by container name (default: "test-execution-${Date.now()}").
 *   That container name must exist in the Job's template.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ContainerService = void 0;
const arm_appcontainers_1 = require("@azure/arm-appcontainers");
const identity_1 = require("@azure/identity");
class ContainerService {
    /**
     * @param azureConfig Azure subscription + resource group context used for ARM calls.
     */
    constructor(azureConfig) {
        const credential = new identity_1.DefaultAzureCredential();
        this.client = new arm_appcontainers_1.ContainerAppsAPIClient(credential, azureConfig.subscriptionId);
        this.azureConfig = azureConfig;
    }
    /**
     * startTestExecution()
     * --------------------
     * Starts a *single* execution of a Container Apps Job.
     *
     * @param jobName        Name of the Runner Job (Container Apps Job) to start an execution for.
     * @param testConfig     Matrix cell (env/platform) used to inject ENV + PLATFORM.
     * @param containerConfig Resources + optional image override + runnerEnv passthrough.
     * @param logger         Logger used for progress / error logs.
     */
    async startTestExecution(jobName, testConfig, containerConfig, logger = console) {
        try {
            logger.log(`Starting Job execution: ${jobName} for ${testConfig.env}/${testConfig.platform}`);
            const envList = this.buildExecutionEnv(testConfig, containerConfig.runnerEnv, logger);
            // NOTE:
            // - beginStartAndWait starts an execution and waits for ARM start operation completion
            //   (it does not wait for the actual test run to finish).
            const execution = await this.client.jobs.beginStartAndWait(this.azureConfig.resourceGroup, jobName, {
                template: {
                    containers: [
                        {
                            /**
                             * Container name override:
                             * This must match the container name in the Runner Job template.
                             * If your job uses a different container name, update this constant.
                             */
                            name: `test-executor-${Date.now()}`,
                            // Optional image override (useful for pinning/tagging runs)
                            ...(containerConfig.image ? { image: containerConfig.image } : {}),
                            resources: {
                                cpu: containerConfig.cpu,
                                memory: this.toGi(containerConfig.memoryGB),
                            },
                            env: envList,
                        },
                    ],
                },
            });
            logger.log(`✓ Execution started: ${execution.name}`);
            return {
                jobName,
                executionName: execution.name || "unknown",
                executionId: execution.id,
                config: testConfig,
                success: true,
                startedAt: new Date().toISOString(),
            };
        }
        catch (err) {
            logger.error(`✗ Failed to start execution for ${testConfig.env}/${testConfig.platform} (job=${jobName}):`, err);
            return {
                jobName,
                executionName: "unknown",
                config: testConfig,
                success: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    /**
     * buildExecutionEnv()
     * -------------------
     * Constructs the environment variable list passed into the runner execution.
     *
     * Always includes:
     * - ENV      -> testConfig.env
     * - PLATFORM -> testConfig.platform
     *
     * Optionally includes:
     * - runnerEnv passthrough values from ConfigService (allow-listed)
     *
     * Reserved keys:
     * - ENV / PLATFORM cannot be overridden by runnerEnv to avoid corruption of the matrix.
     */
    buildExecutionEnv(testConfig, runnerEnv, logger) {
        const env = [
            { name: "ENV", value: testConfig.env },
            { name: "PLATFORM", value: testConfig.platform },
        ];
        if (!runnerEnv)
            return env;
        for (const [name, value] of Object.entries(runnerEnv)) {
            if (name === "ENV" || name === "PLATFORM") {
                logger.log(`runnerEnv ignored reserved key '${name}'`);
                continue;
            }
            env.push({ name, value: String(value) });
        }
        return env;
    }
    /**
     * toGi()
     * ------
     * Converts a numeric GB value into a Container Apps memory string (Gi).
     *
     * Container Apps commonly uses "Gi" format (e.g. "1.5Gi").
     * We enforce a minimum to avoid invalid/too-low allocations.
     */
    toGi(memoryGB) {
        const gb = Math.max(0.25, memoryGB);
        // Keep integers without trailing .0 for nicer ARM payloads
        const str = Number.isInteger(gb) ? gb.toFixed(0) : gb.toString();
        return `${str}Gi`;
    }
}
exports.ContainerService = ContainerService;
//# sourceMappingURL=containerService.js.map