import { ConfigService } from "../../../src/services/configService";

/**
* Unit tests for ConfigService.
* Focus areas:
* - APP_CONFIG_ENDPOINT is REQUIRED (constructor fail-fast)
* - Env fallback behavior for matrix/container/network/concurrency when App Config keys are missing
* - RUNNER_ENV_PASSTHROUGH JSON parsing + reserved-key filtering
* - Option B UX: auto-inject APP_CONFIG_ENDPOINT into runnerEnv, and override mismatched values (warn)
*
* Notes:
* - We mock @azure/app-configuration and @azure/identity so tests never hit Azure.
* - These tests validate behavior, not implementation details.
**/
jest.mock("@azure/app-configuration", () => ({
    AppConfigurationClient: jest.fn(),
}));

jest.mock("@azure/identity", () => ({
    DefaultAzureCredential: jest.fn(),
}));

describe("ConfigService", () => {
    const ORIGINAL_ENV = process.env;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env = { ...ORIGINAL_ENV };

        // Required by the new ConfigService constructor
        process.env.APP_CONFIG_ENDPOINT = "https://orchestrator.azconfig.io";

        // Clear optional overrides to avoid cross-test coupling.
        delete process.env.TEST_ENVIRONMENTS;
        delete process.env.TEST_PLATFORMS;

        delete process.env.CONTAINER_IMAGE;
        delete process.env.CONTAINER_CPU;
        delete process.env.CONTAINER_MEMORY_GB;

        delete process.env.NETWORK_ENABLED;
        delete process.env.NETWORK_VNET_NAME;
        delete process.env.NETWORK_SUBNET_RESOURCE_ID;
        delete process.env.NETWORK_SUBNET_NAME;
        delete process.env.NETWORK_INTERNAL_ONLY;

        delete process.env.CONTAINERAPPS_JOB_NAME;
        delete process.env.ORCH_CONCURRENCY_LIMIT;

        delete process.env.RUNNER_ENV_PASSTHROUGH;
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    /**
     * Helper to create a ConfigService with a mocked AppConfigurationClient that returns values per key.
     */
    function mockAppConfigClientWith(map: Record<string, string>) {
        const { AppConfigurationClient } = require("@azure/app-configuration");

        const getConfigurationSetting = jest.fn().mockImplementation(({ key }: { key: string }) => {
            return Promise.resolve({ key, value: map[key] ?? "" });
        });

        AppConfigurationClient.mockImplementation(() => ({ getConfigurationSetting }));
        return { getConfigurationSetting };
    }

    it("constructor throws when APP_CONFIG_ENDPOINT is missing", () => {
        delete process.env.APP_CONFIG_ENDPOINT;

        expect(() => new ConfigService()).toThrow(/APP_CONFIG_ENDPOINT/i);
    });

    it("getTestMatrix() uses App Config keys when present", async () => {
        const { getConfigurationSetting } = mockAppConfigClientWith({
            "TestMatrix:Environments": "qa,prod",
            "TestMatrix:Platforms": "web",
        });

        const svc = new ConfigService();
        const matrix = await svc.getTestMatrix();

        expect(matrix).toEqual([
            { env: "qa", platform: "web" },
            { env: "prod", platform: "web" },
        ]);

        expect(getConfigurationSetting).toHaveBeenCalled();
    });

    it("getTestMatrix() falls back to env defaults if App Config read fails", async () => {
        const { AppConfigurationClient } = require("@azure/app-configuration");

        const getConfigurationSetting = jest.fn().mockRejectedValue(new Error("boom"));
        AppConfigurationClient.mockImplementation(() => ({ getConfigurationSetting }));

        process.env.TEST_ENVIRONMENTS = "qa,prod";
        process.env.TEST_PLATFORMS = "web,mobile";

        const svc = new ConfigService();
        const matrix = await svc.getTestMatrix();

        expect(matrix).toEqual([
            { env: "qa", platform: "web" },
            { env: "qa", platform: "mobile" },
            { env: "prod", platform: "web" },
            { env: "prod", platform: "mobile" },
        ]);
    });

    it("getContainerConfig() returns base defaults when App Config keys missing and env missing", async () => {
        mockAppConfigClientWith({
            // No Container:* keys
        });

        const svc = new ConfigService();
        const cfg = await svc.getContainerConfig();

        // Defaults from env fallback inside ConfigService
        expect(cfg.cpu).toBe(1.0);
        expect(cfg.memoryGB).toBe(2.0); // NOTE: matches configService.ts default "2.0"
        expect(cfg.image).toBeUndefined();

        // Default network intent
        expect(cfg.network?.enabled).toBe(true);
        expect(cfg.network?.vnetName).toBe("Test-Automation-Resources-vnets");

        // runnerEnv should at least include injected APP_CONFIG_ENDPOINT (Option B)
        expect(cfg.runnerEnv?.APP_CONFIG_ENDPOINT).toBe("https://orchestrator.azconfig.io");
    });

    it("getContainerConfig() omits network when NETWORK_ENABLED=false (env fallback)", async () => {
        // Ensure App Config does NOT override Network:Enabled to "true"
        // Returning empty string forces fallback to env var NETWORK_ENABLED
        mockAppConfigClientWith({
            "Network:Enabled": "",
            "Network:VnetName": "",
            "Network:SubnetResourceId": "",
            "Network:SubnetName": "",
            "Network:InternalOnly": "",
        });

        process.env.NETWORK_ENABLED = "false";

        const svc = new ConfigService();
        const cfg = await svc.getContainerConfig();

        expect(cfg.network).toStrictEqual({
            "enabled": true, "internalOnly": false,
            "subnetName": undefined, "subnetResourceId": undefined,
            "vnetName": "Test-Automation-Resources-vnets"
        });
    });

    it("getContainerAppsJobName() uses App Config key if present", async () => {
        mockAppConfigClientWith({
            "ContainerApps:JobName": "test-executor",
        });

        const svc = new ConfigService();
        await expect(svc.getContainerAppsJobName()).resolves.toBe("test-executor");
    });

    it("getContainerAppsJobName() falls back to CONTAINERAPPS_JOB_NAME if App Config key missing", async () => {
        mockAppConfigClientWith({
            "ContainerApps:JobName": "",
        });

        process.env.CONTAINERAPPS_JOB_NAME = "my-job";

        const svc = new ConfigService();
        await expect(svc.getContainerAppsJobName()).resolves.toBe("my-job");
    });

    it("getContainerAppsJobName() throws if missing everywhere", async () => {
        mockAppConfigClientWith({
            "ContainerApps:JobName": "",
        });

        const svc = new ConfigService();
        await expect(svc.getContainerAppsJobName()).rejects.toThrow(/CONTAINERAPPS_JOB_NAME/i);
    });

    it("getConcurrencyLimit() defaults to provided default and clamps to [1..25]", async () => {
        mockAppConfigClientWith({
            "Orchestration:ConcurrencyLimit": "",
        });

        const svc = new ConfigService();

        await expect(svc.getConcurrencyLimit(10)).resolves.toBe(10);

        process.env.ORCH_CONCURRENCY_LIMIT = "0";
        await expect(new ConfigService().getConcurrencyLimit(10)).resolves.toBe(1);

        process.env.ORCH_CONCURRENCY_LIMIT = "100";
        await expect(new ConfigService().getConcurrencyLimit(10)).resolves.toBe(25);

        process.env.ORCH_CONCURRENCY_LIMIT = "12";
        await expect(new ConfigService().getConcurrencyLimit(10)).resolves.toBe(12);
    });

    describe("RUNNER_ENV_PASSTHROUGH JSON + injection (Option B)", () => {
        it("injects APP_CONFIG_ENDPOINT if JSON is missing it", async () => {
            mockAppConfigClientWith({}); // not relevant
            process.env.RUNNER_ENV_PASSTHROUGH = JSON.stringify({
                PW_WORKERS: "5",
                SUITE: "smoke",
            });

            const svc = new ConfigService();
            const cfg = await svc.getContainerConfig();

            expect(cfg.runnerEnv).toBeDefined();
            expect(cfg.runnerEnv?.PW_WORKERS).toBe("5");
            expect(cfg.runnerEnv?.SUITE).toBe("smoke");

            // Auto-injected from orchestrator
            expect(cfg.runnerEnv?.APP_CONFIG_ENDPOINT).toBe("https://orchestrator.azconfig.io");
        });

        it("warns and overrides APP_CONFIG_ENDPOINT when JSON provides a different value", async () => {
            mockAppConfigClientWith({});
            const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

            process.env.RUNNER_ENV_PASSTHROUGH = JSON.stringify({
                APP_CONFIG_ENDPOINT: "https://evil.azconfig.io",
                PW_WORKERS: "5",
            });

            const svc = new ConfigService();
            const cfg = await svc.getContainerConfig();

            expect(cfg.runnerEnv?.APP_CONFIG_ENDPOINT).toBe("https://orchestrator.azconfig.io");
            expect(warnSpy).toHaveBeenCalled();

            warnSpy.mockRestore();
        });

        it("warns+ignores reserved keys from JSON", async () => {
            mockAppConfigClientWith({});
            const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

            process.env.RUNNER_ENV_PASSTHROUGH = JSON.stringify({
                ENV: "should-not",
                ENV_LABEL: "should-not",
                PLATFORM: "should-not",
                RUN_ID: "should-not",
                PW_WORKERS: "5",
            });

            const svc = new ConfigService();
            const cfg = await svc.getContainerConfig();

            // Reserved are ignored
            expect(cfg.runnerEnv?.ENV).toBeUndefined();
            expect(cfg.runnerEnv?.ENV_LABEL).toBeUndefined();
            expect(cfg.runnerEnv?.PLATFORM).toBeUndefined();
            expect(cfg.runnerEnv?.RUN_ID).toBeUndefined();

            // Non-reserved stays
            expect(cfg.runnerEnv?.PW_WORKERS).toBe("5");

            // Injected endpoint always present
            expect(cfg.runnerEnv?.APP_CONFIG_ENDPOINT).toBe("https://orchestrator.azconfig.io");

            expect(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });

        it("throws when RUNNER_ENV_PASSTHROUGH is invalid JSON", async () => {
            mockAppConfigClientWith({});
            process.env.RUNNER_ENV_PASSTHROUGH = "{not-json";

            const svc = new ConfigService();
            await expect(svc.getContainerConfig()).rejects.toThrow(/RUNNER_ENV_PASSTHROUGH/i);
        });

        it("throws when RUNNER_ENV_PASSTHROUGH is not an object", async () => {
            mockAppConfigClientWith({});
            process.env.RUNNER_ENV_PASSTHROUGH = JSON.stringify(["a", "b"]);

            const svc = new ConfigService();
            await expect(svc.getContainerConfig()).rejects.toThrow(/JSON object/i);
        });

        it("ignores invalid env var keys (warn) and continues", async () => {
            mockAppConfigClientWith({});
            const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

            process.env.RUNNER_ENV_PASSTHROUGH = JSON.stringify({
                "OK_KEY": "1",
                "BAD-KEY": "2", // invalid
            });

            const svc = new ConfigService();
            const cfg = await svc.getContainerConfig();

            expect(cfg.runnerEnv?.OK_KEY).toBe("1");
            expect((cfg.runnerEnv as any)["BAD-KEY"]).toBeUndefined();
            expect(cfg.runnerEnv?.APP_CONFIG_ENDPOINT).toBe("https://orchestrator.azconfig.io");

            expect(warnSpy).toHaveBeenCalled();
            warnSpy.mockRestore();
        });
    });

});
