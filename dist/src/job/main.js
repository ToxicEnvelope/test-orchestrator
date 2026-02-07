"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = main;
exports.resolveCustomMatrixFromEnv = resolveCustomMatrixFromEnv;
exports.getAzureConfig = getAzureConfig;
exports.requireEnv = requireEnv;
const containerService_1 = require("../services/containerService");
const configService_1 = require("../services/configService");
const orchestrationService_1 = require("../services/orchestrationService");
/**
 * TestOrchestrator Job Entrypoint (Container Apps Job)
 * ---------------------------------------------------
 * This is the main entrypoint when running TestOrchestrator as a Container Apps Job.
 *
 * Modes:
 * 1) Scheduled/default mode:
 *    - TEST_CONFIGS_JSON is NOT set (or empty)
 *    - Uses ConfigService.getTestMatrix() to build the matrix (App Config or env defaults)
 *
 * 2) Manual/custom mode:
 *    - TEST_CONFIGS_JSON is set to a JSON array:
 *        [{"env":"qa","platform":"web"},{"env":"prod","platform":"mobile"}]
 *    - Runs only the provided matrix (no defaults are added)
 *
 * Exit codes:
 *  - 0 => all executions started successfully
 *  - 1 => one or more executions failed to start OR a fatal error occurred
 */
async function main() {
    console.log("=".repeat(60));
    console.log("TestOrchestrator Job Started (Container Apps Jobs)");
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log("=".repeat(60));
    try {
        const azureConfig = getAzureConfig();
        const configService = new configService_1.ConfigService();
        const containerService = new containerService_1.ContainerService(azureConfig);
        const orchestrationService = new orchestrationService_1.OrchestrationService(containerService, configService);
        const customMatrix = resolveCustomMatrixFromEnv();
        if (customMatrix) {
            console.log(`Custom matrix provided: ${customMatrix.length} configurations`);
            customMatrix.forEach((c) => console.log(`  - ${c.env}/${c.platform}`));
        }
        else {
            console.log("No custom matrix provided -> using defaults from ConfigService");
        }
        // If customMatrix is undefined, OrchestrationService will use defaults.
        const result = await orchestrationService.executeTests(customMatrix, console);
        process.exit(result.success ? 0 : 1);
    }
    catch (err) {
        console.error("Fatal error in job entrypoint:", err);
        process.exit(1);
    }
}
/**
 * Reads TEST_CONFIGS_JSON from env and converts it into TestConfig[].
 *
 * Env var format:
 *  TEST_CONFIGS_JSON='[{"env":"qa","platform":"web"},{"env":"prod","platform":"mobile"}]'
 *
 * Returns:
 *  - undefined if not provided (so orchestration uses defaults)
 *  - TestConfig[] if provided and valid
 *
 * Throws:
 *  - Error if provided but invalid JSON or invalid schema
 */
function resolveCustomMatrixFromEnv() {
    const raw = (process.env.TEST_CONFIGS_JSON || "").trim();
    if (!raw)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        throw new Error("Invalid TEST_CONFIGS_JSON: must be valid JSON");
    }
    if (!Array.isArray(parsed)) {
        throw new Error("Invalid TEST_CONFIGS_JSON: must be a JSON array of { env, platform } objects");
    }
    const configs = parsed.map((item, i) => {
        const env = item?.env;
        const platform = item?.platform;
        if (typeof env !== "string" || !env.trim()) {
            throw new Error(`Invalid TEST_CONFIGS_JSON item #${i}: missing valid 'env'`);
        }
        if (typeof platform !== "string" || !platform.trim()) {
            throw new Error(`Invalid TEST_CONFIGS_JSON item #${i}: missing valid 'platform'`);
        }
        return { env: env.trim(), platform: platform.trim() };
    });
    return configs.length ? configs : undefined;
}
/**
 * Builds AzureConfig from environment variables.
 *
 * Required:
 * - AZURE_SUBSCRIPTION_ID
 * - RESOURCE_GROUP_NAME
 *
 * Optional:
 * - AZURE_LOCATION (defaults to "West Europe")
 */
function getAzureConfig() {
    const location = (process.env.AZURE_LOCATION || "").trim() || "westeurope";
    return {
        subscriptionId: requireEnv("AZURE_SUBSCRIPTION_ID"),
        resourceGroup: requireEnv("RESOURCE_GROUP_NAME"),
        location,
    };
}
/**
 * Ensures an env var exists and is non-empty (fail-fast).
 */
function requireEnv(name) {
    const value = (process.env[name] || "").trim();
    if (!value)
        throw new Error(`Missing required environment variable: ${name}`);
    return value;
}
// Run immediately when the container starts
if (process.env.NODE_ENV !== "test") {
    void main();
}
//# sourceMappingURL=main.js.map