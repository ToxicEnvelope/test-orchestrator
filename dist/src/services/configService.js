"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigService = void 0;
const app_configuration_1 = require("@azure/app-configuration");
const identity_1 = require("@azure/identity");
/**
 * ConfigService
 * -------------
 * Loads configuration for TestOrchestrator.
 *
 * Source priority:
 *   1) Azure App Configuration (if enabled)
 *   2) Environment variables (fallback)
 *
 * App Configuration enablement:
 *   - APP_CONFIG_CONNECTION_STRING
 *   - OR APP_CONFIG_ENDPOINT + DefaultAzureCredential (recommended with Managed Identity)
 *
 * Responsibilities:
 *   - Test matrix (env/platform combinations)
 *   - Runner container settings (cpu/memory + optional image override)
 *   - Container Apps Job name (for starting executions)
 *   - Network intent (VNet/subnet info for validation/logging)
 *   - Orchestration concurrency limit (max concurrent "start execution" calls)
 *   - Runner env passthrough: allow-list of env vars to forward into the runner execution
 *
 * Runner env passthrough (env-only, human readable):
 *   - RUNNER_ENV_PASSTHROUGH="BASE_URL,PW_WORKERS,ALLURE_ENDPOINT"
 *   - plus values set on the orchestrator job:
 *       BASE_URL=...
 *       PW_WORKERS=...
 *       ALLURE_ENDPOINT=...
 *
 * The resulting map is placed on ContainerConfig.runnerEnv, and later injected into the
 * runner execution env list by ContainerService.
 */
class ConfigService {
    constructor() {
        this.client = null;
        const connectionString = process.env.APP_CONFIG_CONNECTION_STRING;
        const endpoint = process.env.APP_CONFIG_ENDPOINT;
        this.useAppConfig = !!(connectionString || endpoint);
        if (connectionString) {
            this.client = new app_configuration_1.AppConfigurationClient(connectionString);
        }
        else if (endpoint) {
            const credential = new identity_1.DefaultAzureCredential();
            this.client = new app_configuration_1.AppConfigurationClient(endpoint, credential);
        }
    }
    /**
     * getTestMatrix()
     * --------------
     * Returns the cross product of environments x platforms.
     *
     * App Config keys:
     *   - TestMatrix:Environments = "qa,stage,prod"
     *   - TestMatrix:Platforms    = "web,mobile"
     *
     * Env fallback:
     *   - TEST_ENVIRONMENTS
     *   - TEST_PLATFORMS
     */
    async getTestMatrix() {
        if (this.useAppConfig && this.client) {
            return await this.getTestMatrixFromAppConfig();
        }
        return this.getTestMatrixFromEnv();
    }
    async getTestMatrixFromAppConfig() {
        try {
            const envSetting = await this.client.getConfigurationSetting({
                key: "TestMatrix:Environments",
            });
            const platformSetting = await this.client.getConfigurationSetting({
                key: "TestMatrix:Platforms",
            });
            const environments = (envSetting.value || "qa")
                .split(",")
                .map((e) => e.trim())
                .filter(Boolean);
            const platforms = (platformSetting.value || "web")
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);
            return environments.flatMap((env) => platforms.map((platform) => ({ env, platform })));
        }
        catch (error) {
            console.error("Failed to load test matrix from App Config, using env defaults:", error);
            return this.getTestMatrixFromEnv();
        }
    }
    getTestMatrixFromEnv() {
        const environments = (process.env.TEST_ENVIRONMENTS || "prod,stage,qa")
            .split(",")
            .map((e) => e.trim())
            .filter(Boolean);
        const platforms = (process.env.TEST_PLATFORMS || "web,mobile")
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
        return Promise.resolve(environments.flatMap((env) => platforms.map((platform) => ({ env, platform }))));
    }
    /**
     * getContainerConfig()
     * -------------------
     * Runner settings used when starting a job execution.
     *
     * Includes:
     * - base resources (cpu/memory) and optional image override
     * - optional network intent
     * - optional runnerEnv passthrough map (RUNNER_ENV_PASSTHROUGH)
     */
    async getContainerConfig() {
        const base = await this.getContainerConfigBase();
        const network = await this.getNetworkConfig();
        const runnerEnv = this.getRunnerEnvPassthroughMap();
        return {
            ...base,
            network: network.enabled ? network : undefined,
            runnerEnv: Object.keys(runnerEnv).length ? runnerEnv : undefined,
        };
    }
    async getContainerConfigBase() {
        if (this.useAppConfig && this.client) {
            try {
                const [imageSetting, cpuSetting, memorySetting] = await Promise.all([
                    this.client.getConfigurationSetting({ key: "Container:Image" }),
                    this.client.getConfigurationSetting({ key: "Container:CPU" }),
                    this.client.getConfigurationSetting({ key: "Container:MemoryGB" }),
                ]);
                const image = (imageSetting.value || process.env.CONTAINER_IMAGE || "").trim();
                return {
                    image: image || undefined,
                    cpu: parseFloat(cpuSetting.value || process.env.CONTAINER_CPU || "1.0"),
                    memoryGB: parseFloat(memorySetting.value || process.env.CONTAINER_MEMORY_GB || "1.5"),
                };
            }
            catch (error) {
                console.error("Failed to load container config from App Config, using env defaults:", error);
            }
        }
        const image = (process.env.CONTAINER_IMAGE || "").trim();
        return {
            image: image || undefined,
            cpu: parseFloat(process.env.CONTAINER_CPU || "1.0"),
            memoryGB: parseFloat(process.env.CONTAINER_MEMORY_GB || "1.5"),
        };
    }
    /**
     * getContainerAppsJobName()
     * ------------------------
     * Name of the Container Apps Job to start executions for.
     *
     * App Config key:
     *   - ContainerApps:JobName
     *
     * Env fallback:
     *   - CONTAINERAPPS_JOB_NAME
     */
    async getContainerAppsJobName() {
        if (this.useAppConfig && this.client) {
            try {
                const setting = await this.client.getConfigurationSetting({
                    key: "ContainerApps:JobName",
                });
                const value = (setting.value || "").trim();
                if (value)
                    return value;
            }
            catch (error) {
                console.error("Failed to load ContainerApps:JobName from App Config:", error);
            }
        }
        const envValue = (process.env.CONTAINERAPPS_JOB_NAME || "").trim();
        if (!envValue) {
            throw new Error("Missing CONTAINERAPPS_JOB_NAME (or App Config key ContainerApps:JobName)");
        }
        return envValue;
    }
    /**
     * getNetworkConfig()
     * -----------------
     * Network intent for validation/logging.
     *
     * Default expectation:
     *  - VNet name: "Isrotel-Automation-Resources-vnets"
     */
    async getNetworkConfig() {
        const defaultVnetName = "Isrotel-Automation-Resources-vnets";
        if (this.useAppConfig && this.client) {
            try {
                const [enabledSetting, vnetNameSetting, subnetIdSetting, subnetNameSetting, internalOnlySetting,] = await Promise.all([
                    this.safeGet("Network:Enabled"),
                    this.safeGet("Network:VnetName"),
                    this.safeGet("Network:SubnetResourceId"),
                    this.safeGet("Network:SubnetName"),
                    this.safeGet("Network:InternalOnly"),
                ]);
                return {
                    enabled: this.parseBool(enabledSetting?.value ?? process.env.NETWORK_ENABLED, true),
                    vnetName: (vnetNameSetting?.value || process.env.NETWORK_VNET_NAME || defaultVnetName).trim(),
                    subnetResourceId: subnetIdSetting?.value || process.env.NETWORK_SUBNET_RESOURCE_ID,
                    subnetName: subnetNameSetting?.value || process.env.NETWORK_SUBNET_NAME,
                    internalOnly: this.parseBool(internalOnlySetting?.value ?? process.env.NETWORK_INTERNAL_ONLY, false),
                };
            }
            catch (error) {
                console.error("Failed to load network config from App Config, using env defaults:", error);
            }
        }
        return {
            enabled: this.parseBool(process.env.NETWORK_ENABLED, true),
            vnetName: (process.env.NETWORK_VNET_NAME || defaultVnetName).trim(),
            subnetResourceId: process.env.NETWORK_SUBNET_RESOURCE_ID,
            subnetName: process.env.NETWORK_SUBNET_NAME,
            internalOnly: this.parseBool(process.env.NETWORK_INTERNAL_ONLY, false),
        };
    }
    /**
     * getConcurrencyLimit()
     * ---------------------
     * Limits how many "start job execution" calls are made concurrently.
     *
     * App Config key:
     *   - Orchestration:ConcurrencyLimit
     *
     * Env fallback:
     *   - ORCH_CONCURRENCY_LIMIT
     *
     * Default: 10
     * Bounds: 1..50
     */
    async getConcurrencyLimit(defaultValue = 10) {
        const clamp = (n) => Math.max(1, Math.min(50, n));
        if (this.useAppConfig && this.client) {
            try {
                const setting = await this.client.getConfigurationSetting({
                    key: "Orchestration:ConcurrencyLimit",
                });
                const raw = (setting.value || "").trim();
                if (raw) {
                    const parsed = Number(raw);
                    if (!Number.isNaN(parsed) && Number.isFinite(parsed))
                        return clamp(parsed);
                }
            }
            catch (error) {
                console.error("Failed to load Orchestration:ConcurrencyLimit from App Config:", error);
            }
        }
        const envRaw = (process.env.ORCH_CONCURRENCY_LIMIT || "").trim();
        if (envRaw) {
            const parsed = Number(envRaw);
            if (!Number.isNaN(parsed) && Number.isFinite(parsed))
                return clamp(parsed);
        }
        return clamp(defaultValue);
    }
    // -------------------------
    // Runner env passthrough
    // -------------------------
    /**
     * getRunnerEnvPassthroughMap()
     * ----------------------------
     * Reads a comma-separated allow-list from RUNNER_ENV_PASSTHROUGH and builds
     * a map of env vars to inject into the runner execution.
     *
     * Example:
     *   RUNNER_ENV_PASSTHROUGH="BASE_URL,PW_WORKERS,ALLURE_ENDPOINT"
     *   BASE_URL="https://qa.example.com"
     *   PW_WORKERS="5"
     *
     * Reserved names:
     *   - ENV, PLATFORM are always set by the orchestrator per matrix cell
     */
    getRunnerEnvPassthroughMap() {
        const raw = (process.env.RUNNER_ENV_PASSTHROUGH || "").trim();
        if (!raw)
            return {};
        const names = raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const out = {};
        for (const name of names) {
            if (!this.isValidEnvVarName(name)) {
                console.warn(`RUNNER_ENV_PASSTHROUGH: ignoring invalid env var name '${name}'`);
                continue;
            }
            if (name === "ENV" || name === "PLATFORM") {
                console.warn(`RUNNER_ENV_PASSTHROUGH: '${name}' is reserved and will be ignored`);
                continue;
            }
            const value = process.env[name];
            if (value === undefined) {
                // Not set on the orchestrator job - skip silently (or warn if you prefer)
                continue;
            }
            out[name] = String(value);
        }
        return out;
    }
    isValidEnvVarName(name) {
        // Conservative validation to prevent ARM API errors
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    }
    // -------------------------
    // Helpers
    // -------------------------
    parseBool(value, defaultValue) {
        if (value === undefined || value === null)
            return defaultValue;
        const v = String(value).trim().toLowerCase();
        if (v === "true" || v === "1" || v === "yes" || v === "y")
            return true;
        if (v === "false" || v === "0" || v === "no" || v === "n")
            return false;
        return defaultValue;
    }
    async safeGet(key) {
        try {
            return await this.client.getConfigurationSetting({ key });
        }
        catch {
            return undefined;
        }
    }
}
exports.ConfigService = ConfigService;
//# sourceMappingURL=configService.js.map