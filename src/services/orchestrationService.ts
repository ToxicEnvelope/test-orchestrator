import { ContainerService, Logger } from "./containerService";
import { ConfigService } from "./configService";
import { TestConfig, TestExecutionResponse } from "../types";

/**
 * OrchestrationService
 * --------------------
 * Coordinates the full "start runner executions" flow:
 * - Resolve test matrix (defaults or custom)
 * - Load runner container config (resources + optional image override + runnerEnv passthrough)
 * - Resolve target Runner Job name (Container Apps Job)
 * - Start executions for each matrix cell
 * - Apply concurrency limiting (default 10) to avoid throttling
 *
 * Notes:
 * - Agnostic Job-only runtime (Using Container App Job Scheduler).
 * - This service starts executions and returns immediately; it does NOT wait for test completion.
 */
export class OrchestrationService {
    private containerService: ContainerService;
    private configService: ConfigService;

    constructor(containerService: ContainerService, configService: ConfigService) {
        this.containerService = containerService;
        this.configService = configService;
    }

    /**
     * executeTests()
     * --------------
     * Starts Container Apps Job executions for the provided matrix.
     *
     * @param testConfigs Optional custom matrix. If undefined/empty, defaults are loaded via ConfigService.getTestMatrix().
     * @param logger      Logger implementation. Must support { log, error }. Defaults to console.
     */
    async executeTests(testConfigs?: TestConfig[], logger: Logger = console): Promise<TestExecutionResponse> {
        const startTime = Date.now();

        // Defensive logger normalization (prevents "log is not a function" in tests/mocks)
        const log: Logger["log"] = typeof logger?.log === "function" ? logger.log.bind(logger) : console.log.bind(console);
        const error: Logger["error"] =
            typeof logger?.error === "function" ? logger.error.bind(logger) : console.error.bind(console);

        log("=".repeat(60));
        log("Test Execution Started (Container Apps Jobs)");
        log(`Timestamp: ${new Date().toISOString()}`);
        log("=".repeat(60));

        try {
            // 1) Resolve test matrix
            const usingCustom = !!(testConfigs && testConfigs.length > 0);
            const finalTestConfigs: TestConfig[] = usingCustom
                ? testConfigs!
                : await this.configService.getTestMatrix();

            log(usingCustom ? "Using custom configuration:" : "Using default configuration from settings");
            log(`Test Matrix: ${finalTestConfigs.length} configurations`);
            finalTestConfigs.forEach((c) => log(`  - ${c.env}/${c.platform}`));

            // 2) Runner execution configuration (resources + runnerEnv passthrough)
            const containerConfig = await this.configService.getContainerConfig();

            // 3) Runner Job name (the Job whose executions we start)
            const jobName = await this.configService.getContainerAppsJobName();

            // 4) Concurrency limit for starting executions (default 10)
            const concurrencyLimit = await this.configService.getConcurrencyLimit();

            log(`Runner Job (Container Apps Job): ${jobName}`);
            log(`Image override: ${containerConfig.image || "(use job default image)"}`);
            log(`Resources: ${containerConfig.cpu} CPU, ${containerConfig.memoryGB}GB RAM`);
            log(`Concurrency limit: ${concurrencyLimit}`);

            if (containerConfig.runnerEnv && Object.keys(containerConfig.runnerEnv).length > 0) {
                log(`Runner env passthrough: ${Object.keys(containerConfig.runnerEnv).join(", ")}`);
            } else {
                log("Runner env passthrough: (none)");
            }

            if (containerConfig.network?.enabled) {
                log(`Network intent: enabled (VNet=${containerConfig.network.vnetName})`);
                if (containerConfig.network.subnetName) log(`Subnet: ${containerConfig.network.subnetName}`);
                if (containerConfig.network.subnetResourceId) log(`SubnetResourceId: ${containerConfig.network.subnetResourceId}`);
            } else {
                log("Network intent: not specified (handled by Container Apps Environment)");
            }

            // 5) Start executions with concurrency control
            log("--- Job Execution Start Phase ---");

            const results = await this.runWithConcurrencyLimit(
                finalTestConfigs,
                concurrencyLimit,
                async (config) =>
                    // IMPORTANT: jobName is passed explicitly (not read from AzureConfig)
                    this.containerService.startTestExecution(jobName, config, containerConfig, logger)
            );

            // 6) Summarize
            const successful = results.filter((r) => r.success).length;
            const failed = results.filter((r) => !r.success).length;

            log("=".repeat(60));
            log("Job Execution Start Summary");
            log("=".repeat(60));
            log(`Total: ${results.length}`);
            log(`✓ Successful: ${successful}`);
            log(`✗ Failed: ${failed}`);

            if (failed > 0) {
                log("Failed Executions:");
                results
                    .filter((r) => !r.success)
                    .forEach((r) => log(`  - ${r.config.env}/${r.config.platform}: ${r.error}`));
            }

            // Helpful hint for the most common failure mode:
            // runner Job doesn't exist (Microsoft.App/jobs/<name> not found)
            const allFailed = results.length > 0 && failed === results.length;
            if (allFailed) {
                const errors = results.map((r) => (r.error || "").toLowerCase());
                const looksLikeJobNotFound = errors.some(
                    (e) =>
                        e.includes("microsoft.app/jobs") &&
                        (e.includes("not found") || e.includes("resourcenotfound"))
                );

                if (looksLikeJobNotFound) {
                    log("");
                    log("⚠️  All executions failed because the Runner Job was not found.");
                    log(`Create a Container Apps Job named "${jobName}" in resource group, then re-run.`);
                    log('Also ensure the Job template container name matches the override name (default "test-runner").');
                }
            }

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            log(`Execution Time: ${duration}s`);
            log("=".repeat(60));
            log("✓ Orchestration completed. Executions running independently.");
            log("=".repeat(60));

            return {
                success: failed === 0,
                message: failed === 0 ? "All executions started successfully" : `${failed} execution(s) failed to start`,
                totalExecutions: results.length,
                successful,
                failed,
                executions: results,
                timestamp: new Date().toISOString(),
            };
        } catch (err) {
            error("Fatal error in orchestration:", err);
            throw err;
        }
    }

    /**
     * runWithConcurrencyLimit()
     * -------------------------
     * Runs async operations over items while limiting the number of concurrent tasks.
     *
     * Why:
     * - Avoid ARM throttling when starting multiple executions
     * - Keep bursts under control even if matrix grows
     */
    private async runWithConcurrencyLimit<TItem, TResult>(
        items: TItem[],
        concurrencyLimit: number,
        worker: (item: TItem) => Promise<TResult>
    ): Promise<TResult[]> {
        const limit = Math.max(1, concurrencyLimit);
        const results: TResult[] = new Array(items.length);
        let index = 0;

        const lanes = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
            while (true) {
                const current = index++;
                if (current >= items.length) return;
                results[current] = await worker(items[current]);
            }
        });

        await Promise.all(lanes);
        return results;
    }
}