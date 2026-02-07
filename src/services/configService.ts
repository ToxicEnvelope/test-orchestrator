import { AppConfigurationClient } from "@azure/app-configuration";
import { DefaultAzureCredential } from "@azure/identity";
import { ContainerConfig, TestConfig, VNetConfig } from "../types";

/**
 * ConfigService
 * -------------
 * Loads configuration for TestOrchestrator.
 *
 * Source priority:
 *   1) Azure App Configuration (always, required)
 *   2) Environment variables as fallback defaults (when AppConfig keys are missing)
 *
 * Authentication:
 *   - APP_CONFIG_ENDPOINT + DefaultAzureCredential (Managed Identity / workload identity / env creds)
 *
 * Responsibilities:
 *   - Test matrix (env/platform combinations)
 *   - Runner container settings (cpu/memory + optional image override)
 *   - Container Apps Job name (for starting executions)
 *   - Network intent (VNet/subnet info for validation/logging)
 *   - Orchestration concurrency limit (max concurrent "start execution" calls)
 *   - Runner env passthrough: JSON map of env vars to forward into the runner execution
 *
 * Runner env passthrough:
 *   - RUNNER_ENV_PASSTHROUGH='{"SUITE":"smoke","PW_WORKERS":"5"}'
 *
 * Best-UX injection:
 *   - APP_CONFIG_ENDPOINT is REQUIRED for the orchestrator.
 *   - If RUNNER_ENV_PASSTHROUGH JSON does not include APP_CONFIG_ENDPOINT, we inject it automatically.
 *   - If JSON includes a DIFFERENT APP_CONFIG_ENDPOINT, we warn and override it to the orchestrator endpoint
 *     (safest and avoids subtle misconfig between orchestrator and runner).
 *
 * Reserved keys (controlled by orchestrator / per-execution injection):
 *   - ENV
 *   - ENV_LABEL
 *   - PLATFORM
 *   - RUN_ID
 *
 * These keys are warned+ignored if supplied via RUNNER_ENV_PASSTHROUGH.
 */
export class ConfigService {
    private client: AppConfigurationClient;

    constructor() {
        const endpoint = (process.env.APP_CONFIG_ENDPOINT || "").trim();
        if (!endpoint) {
            throw new Error("Missing required environment variable: APP_CONFIG_ENDPOINT");
        }

        const credential = new DefaultAzureCredential();
        this.client = new AppConfigurationClient(endpoint, credential);
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
    async getTestMatrix(): Promise<TestConfig[]> {
        return await this.getTestMatrixFromAppConfig();
    }

    private async getTestMatrixFromAppConfig(): Promise<TestConfig[]> {
        try {
            const envSetting = await this.client.getConfigurationSetting({
                key: "TestMatrix:Environments",
            });
            const platformSetting = await this.client.getConfigurationSetting({
                key: "TestMatrix:Platforms",
            });

            const environments = (envSetting.value || process.env.TEST_ENVIRONMENTS || "prod,stage,qa")
                .split(",")
                .map((e) => e.trim())
                .filter(Boolean);

            const platforms = (platformSetting.value || process.env.TEST_PLATFORMS || "web,mobile")
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);

            return environments.flatMap((env) =>
                platforms.map((platform) => ({ env, platform }))
            );
        } catch (error) {
            console.error("Failed to load test matrix from App Config, using env defaults:", error);

            const environments = (process.env.TEST_ENVIRONMENTS || "prod,stage,qa")
                .split(",")
                .map((e) => e.trim())
                .filter(Boolean);

            const platforms = (process.env.TEST_PLATFORMS || "web,mobile")
                .split(",")
                .map((p) => p.trim())
                .filter(Boolean);

            return environments.flatMap((env) =>
                platforms.map((platform) => ({ env, platform }))
            );
        }
    }

    /**
     * getContainerConfig()
     * -------------------
     * Runner settings used when starting a job execution.
     *
     * Includes:
     * - base resources (cpu/memory) and optional image override
     * - optional network intent
     * - runnerEnv passthrough map (RUNNER_ENV_PASSTHROUGH JSON), with auto-injected APP_CONFIG_ENDPOINT
     */
    async getContainerConfig(): Promise<ContainerConfig> {
        const base = await this.getContainerConfigBase();
        const network = await this.getNetworkConfig();
        const runnerEnv = this.getRunnerEnvPassthroughMap();

        return {
            ...base,
            network: network.enabled ? network : undefined,
            runnerEnv: Object.keys(runnerEnv).length ? runnerEnv : undefined,
        };
    }

    private async getContainerConfigBase(): Promise<Omit<ContainerConfig, "network" | "runnerEnv">> {
        try {
            const [imageSetting, cpuSetting, memorySetting] = await Promise.all([
                this.safeGet("Container:Image"),
                this.safeGet("Container:CPU"),
                this.safeGet("Container:MemoryGB"),
            ]);

            const image = (imageSetting?.value || process.env.CONTAINER_IMAGE || "").trim();

            return {
                image: image || undefined,
                cpu: parseFloat(cpuSetting?.value || process.env.CONTAINER_CPU || "1.0"),
                memoryGB: parseFloat(memorySetting?.value || process.env.CONTAINER_MEMORY_GB || "2.0"),
            };
        } catch (error) {
            console.error("Failed to load container config from App Config, using env defaults:", error);
        }

        const image = (process.env.CONTAINER_IMAGE || "").trim();
        return {
            image: image || undefined,
            cpu: parseFloat(process.env.CONTAINER_CPU || "1.0"),
            memoryGB: parseFloat(process.env.CONTAINER_MEMORY_GB || "2.0"),
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
    async getContainerAppsJobName(): Promise<string> {
        try {
            const setting = await this.safeGet("ContainerApps:JobName");
            const value = (setting?.value || "").trim();
            if (value) return value;
        } catch (error) {
            console.error("Failed to load ContainerApps:JobName from App Config:", error);
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
    async getNetworkConfig(): Promise<VNetConfig> {
        const defaultVnetName = "Isrotel-Automation-Resources-vnets";

        try {
            const [
                enabledSetting,
                vnetNameSetting,
                subnetIdSetting,
                subnetNameSetting,
                internalOnlySetting,
            ] = await Promise.all([
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
        } catch (error) {
            console.error("Failed to load network config from App Config, using env defaults:", error);
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
     * Bounds: 1..25
     */
    async getConcurrencyLimit(defaultValue = 10): Promise<number> {
        const clamp = (n: number) => Math.max(1, Math.min(25, n));

        try {
            const setting = await this.safeGet("Orchestration:ConcurrencyLimit");
            const raw = (setting?.value || "").trim();
            if (raw) {
                const parsed = Number(raw);
                if (!Number.isNaN(parsed) && Number.isFinite(parsed)) return clamp(parsed);
            }
        } catch (error) {
            console.error("Failed to load Orchestration:ConcurrencyLimit from App Config:", error);
        }

        const envRaw = (process.env.ORCH_CONCURRENCY_LIMIT || "").trim();
        if (envRaw) {
            const parsed = Number(envRaw);
            if (!Number.isNaN(parsed) && Number.isFinite(parsed)) return clamp(parsed);
        }

        return clamp(defaultValue);
    }

    // -------------------------
    // Runner env passthrough (JSON)
    // -------------------------

    /**
     * Reads RUNNER_ENV_PASSTHROUGH as a JSON object (map) and returns a string map.
     *
     * Example:
     *   RUNNER_ENV_PASSTHROUGH='{"PW_WORKERS":"5","SUITE":"smoke"}'
     *
     * Special handling (best UX):
     * - APP_CONFIG_ENDPOINT is REQUIRED for the orchestrator itself.
     * - If missing from JSON, we inject it automatically.
     * - If JSON provides a different APP_CONFIG_ENDPOINT, we warn and override it to match the orchestrator.
     */
    private getRunnerEnvPassthroughMap(): Record<string, string> {
        const orchestratorEndpoint = (process.env.APP_CONFIG_ENDPOINT || "").trim();
        // constructor already enforces this, but keep safe guard for future refactors
        if (!orchestratorEndpoint) {
            throw new Error("Missing required environment variable: APP_CONFIG_ENDPOINT");
        }

        const raw = (process.env.RUNNER_ENV_PASSTHROUGH || "").trim();
        let parsedObj: Record<string, unknown> = {};

        if (raw) {
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch {
                throw new Error(
                    'RUNNER_ENV_PASSTHROUGH must be a valid JSON object. Example: {"PW_WORKERS":"5","SUITE":"smoke"}'
                );
            }

            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("RUNNER_ENV_PASSTHROUGH must be a JSON object (key/value map).");
            }

            parsedObj = parsed as Record<string, unknown>;
        }

        const reserved = new Set(["ENV", "ENV_LABEL", "PLATFORM", "RUN_ID"]);

        const out: Record<string, string> = {};
        for (const [key, val] of Object.entries(parsedObj)) {
            if (!this.isValidEnvVarName(key)) {
                console.warn(`RUNNER_ENV_PASSTHROUGH: ignoring invalid env var key '${key}'`);
                continue;
            }

            if (reserved.has(key)) {
                console.warn(`RUNNER_ENV_PASSTHROUGH: '${key}' is reserved and will be ignored`);
                continue;
            }

            out[key] = val === undefined || val === null ? "" : String(val);
        }

        // Best-UX auto injection for the runner
        if (!out.APP_CONFIG_ENDPOINT) {
            console.warn("RUNNER_ENV_PASSTHROUGH: APP_CONFIG_ENDPOINT missing -> injecting orchestrator APP_CONFIG_ENDPOINT");
            out.APP_CONFIG_ENDPOINT = orchestratorEndpoint;
        } else if (out.APP_CONFIG_ENDPOINT !== orchestratorEndpoint) {
            console.warn(
                "RUNNER_ENV_PASSTHROUGH: APP_CONFIG_ENDPOINT differs from orchestrator endpoint -> overriding to orchestrator APP_CONFIG_ENDPOINT"
            );
            out.APP_CONFIG_ENDPOINT = orchestratorEndpoint;
        }

        return out;
    }

    private isValidEnvVarName(name: string): boolean {
        return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
    }

    // -------------------------
    // Helpers
    // -------------------------

    private parseBool(value: string | undefined, defaultValue: boolean): boolean {
        if (value === undefined || value === null) return defaultValue;
        const v = String(value).trim().toLowerCase();
        if (v === "true" || v === "1" || v === "yes" || v === "y") return true;
        if (v === "false" || v === "0" || v === "no" || v === "n") return false;
        return defaultValue;
    }

    private async safeGet(key: string) {
        try {
            return await this.client.getConfigurationSetting({ key });
        } catch {
            return undefined;
        }
    }
}
