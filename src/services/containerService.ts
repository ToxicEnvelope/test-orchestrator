import { ContainerAppsAPIClient } from "@azure/arm-appcontainers";
import { DefaultAzureCredential } from "@azure/identity";
import { randomUUID } from "node:crypto";
import { AzureConfig, ContainerConfig, JobExecutionResult, TestConfig } from "../types";

/**
 * Minimal logger abstraction so we can run in Container Apps Jobs.
 */
export interface Logger {
    log: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
}

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
 * - injects ENV + ENV_LABEL + PLATFORM + RUN_ID per matrix cell
 * - injects BUILD_NUMBER derived from the runner image tag (new requirement)
 * - optionally injects additional runner environment variables (runnerEnv passthrough)
 *
 * Important implementation detail:
 * - We override the Job execution template by container name (default: "test-executor").
 *   That container name must exist in the Job's template.
 */
export class ContainerService {
    private client: ContainerAppsAPIClient;
    private azureConfig: AzureConfig;

    /**
     * @param azureConfig Azure subscription + resource group context used for ARM calls.
     */
    constructor(azureConfig: AzureConfig) {
        const credential = new DefaultAzureCredential();
        this.client = new ContainerAppsAPIClient(credential, azureConfig.subscriptionId);
        this.azureConfig = azureConfig;
    }

    /**
     * startTestExecution()
     * --------------------
     * Starts a *single* execution of a Container Apps Job.
     *
     * @param jobName        Name of the Runner Job (Container Apps Job) to start an execution for.
     * @param testConfig     Matrix cell (env/platform) used to inject ENV + ENV_LABEL + PLATFORM.
     * @param containerConfig Resources + optional image override + runnerEnv passthrough.
     * @param logger         Logger used for progress / error logs.
     */
    async startTestExecution(
        jobName: string,
        testConfig: TestConfig,
        containerConfig: ContainerConfig,
        logger: Logger = console as unknown as Logger // console has warn/log/error
    ): Promise<JobExecutionResult> {
        try {
            logger.log(`Starting Job execution: ${jobName} for ${testConfig.env}/${testConfig.platform}`);

            // Keep original behavior: image is required for template override
            const image = this.requireTestAutomationRunnerImage(containerConfig.image);

            // Build env list, now also includes BUILD_NUMBER (derived from image tag)
            const envList = this.buildExecutionEnv(testConfig, containerConfig.runnerEnv, image, logger);

            // NOTE:
            // - beginStartAndWait starts an execution and waits for ARM start operation completion
            //   (it does not wait for the actual test run to finish).
            const containerName = (process.env.RUNNER_CONTAINER_NAME || "test-executor").trim();
            const execution = await this.client.jobs.beginStartAndWait(
                this.azureConfig.resourceGroup,
                jobName,
                {
                    template: {
                        containers: [
                            {
                                /**
                                 * Container name override:
                                 * This must match the container name in the Runner Job template.
                                 * If your job uses a different container name, update this constant.
                                 */
                                name: containerName,
                                image,
                                resources: {
                                    cpu: containerConfig.cpu,
                                    memory: this.toGi(containerConfig.memoryGB),
                                },
                                env: envList,
                            },
                        ],
                    },
                }
            );

            logger.log(`✓ Execution started: ${execution.name}`);

            return {
                jobName,
                executionName: execution.name || "unknown",
                executionId: execution.id,
                config: testConfig,
                success: true,
                startedAt: new Date().toISOString(),
            };
        } catch (err) {
            logger.error(
                `✗ Failed to start execution for ${testConfig.env}/${testConfig.platform} (job=${jobName}):`,
                err
            );

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
     * Dynamic keys (always injected per execution):
     * - ENV          -> testConfig.env
     * - ENV_LABEL    -> testConfig.env (alias; runner depends on it)
     * - PLATFORM     -> testConfig.platform
     * - RUN_ID       -> random UUID (unique per execution)
     * - BUILD_NUMBER -> derived from image tag (e.g. repo:TAG -> TAG)
     *
     * Static keys (optional):
     * - runnerEnv passthrough values from ConfigService (JSON map)
     *
     * Reserved keys (warn + ignore if present in runnerEnv):
     * - ENV, ENV_LABEL, PLATFORM, RUN_ID, BUILD_NUMBER
     */
    private buildExecutionEnv(
        testConfig: TestConfig,
        runnerEnv: Record<string, string> | undefined,
        image: string,
        logger: Logger
    ): { name: string; value: string }[] {
        const env: { name: string; value: string }[] = [
            { name: "ENV", value: testConfig.env },
            { name: "ENV_LABEL", value: testConfig.env },
            { name: "PLATFORM", value: testConfig.platform },
            { name: "RUN_ID", value: randomUUID().split('-')[0] },
        ];

        // inject BUILD_NUMBER from image tag
        const buildNumber = this.tryExtractImageTag(image);
        if (buildNumber) {
            env.push({ name: "BUILD_NUMBER", value: buildNumber });
        } else {
            logger.warn(
                "BUILD_NUMBER not injected: could not derive tag from CONTAINER_IMAGE (missing tag or digest image)."
            );
        }

        if (!runnerEnv) return env;

        for (const [name, value] of Object.entries(runnerEnv)) {
            if (name === "ENV" || name === "ENV_LABEL" || name === "PLATFORM" || name === "RUN_ID" || name === "BUILD_NUMBER") {
                logger.warn(`runnerEnv ignored reserved key '${name}'`);
                continue;
            }
            env.push({ name, value: String(value) });
        }

        return env;
    }

    /**
     * tryExtractImageTag()
     * -------------------
     * Extracts the tag from an image reference:
     * - "repo:tag" -> "tag"
     * - "repo@sha256:..." -> undefined (digest has no tag)
     * - "repo" -> undefined
     *
     * Tag detection rule:
     * - The ":" that separates the tag must be AFTER the last "/"
     *   to avoid confusing registry ports, e.g. "myreg:5000/repo:tag".
     */
    private tryExtractImageTag(image: string): string | undefined {
        const v = image.trim();
        if (!v) return undefined;

        // Digest reference: no tag
        if (v.includes("@")) return undefined;

        const lastSlash = v.lastIndexOf("/");
        const lastColon = v.lastIndexOf(":");

        // Tag separator must come after the last slash
        if (lastColon > lastSlash) {
            const tag = v.slice(lastColon + 1).trim();
            return tag || undefined;
        }

        return undefined;
    }

    /**
     * toGi()
     * ------
     * Converts a numeric GB value into a Container Apps memory string (Gi).
     *
     * Container Apps commonly uses "Gi" format (e.g. "1.5Gi").
     * We enforce a minimum to avoid invalid/too-low allocations.
     */
    private toGi(memoryGB: number): string {
        const gb = Math.max(0.25, memoryGB);
        // Keep integers without trailing .0 for nicer ARM payloads
        const str = Number.isInteger(gb) ? gb.toFixed(0) : gb.toString();
        return `${str}Gi`;
    }

    /**
     * requireTestAutomationRunnerImage()
     * ---------------------------------
     * Require the Image of the Test Automation Runner Project.
     */
    private requireTestAutomationRunnerImage(image: string | undefined): string {
        const v = (image || "").trim();
        if (!v) {
            throw new Error(
                "Missing runner image. Set CONTAINER_IMAGE (or AppConfig key Container:Image). " +
                "Azure Job execution template override requires 'image' when specifying template.containers."
            );
        }
        return v;
    }
}
