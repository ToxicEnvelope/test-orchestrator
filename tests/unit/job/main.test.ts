import { importJobMain } from '../../mocks/mainMocks'

// Unit tests for src/job/main.ts (Job-only runtime).
// Covers:
// - resolveCustomMatrixFromEnv(): undefined/default + valid JSON + invalid JSON
// - getAzureConfig(): required envs + default location
// - main(): passes either custom matrix or undefined to executeTests and exits 0/1
//
// Important:
// - src/job/main.ts must export: main, resolveCustomMatrixFromEnv, getAzureConfig, requireEnv
// - src/job/main.ts must NOT auto-run main() when NODE_ENV === "test"

const ORIGINAL_ENV = process.env;

describe("job/main.ts", () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();

        process.env = { ...ORIGINAL_ENV, NODE_ENV: "test" };

        delete process.env.TEST_CONFIGS_JSON;
        delete process.env.AZURE_SUBSCRIPTION_ID;
        delete process.env.RESOURCE_GROUP_NAME;
        delete process.env.AZURE_LOCATION;
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    it("resolveCustomMatrixFromEnv() returns undefined when TEST_CONFIGS_JSON is missing", async () => {
        const mod = await importJobMain();
        expect(mod.resolveCustomMatrixFromEnv()).toBeUndefined();
    });

    it("resolveCustomMatrixFromEnv() parses TEST_CONFIGS_JSON and trims env/platform", async () => {
        const mod = await importJobMain();

        process.env.TEST_CONFIGS_JSON = JSON.stringify([
            { env: " qa ", platform: " web " },
            { env: "prod", platform: "mobile" },
        ]);

        expect(mod.resolveCustomMatrixFromEnv()).toEqual([
            { env: "qa", platform: "web" },
            { env: "prod", platform: "mobile" },
        ]);
    });

    it("resolveCustomMatrixFromEnv() throws on invalid JSON", async () => {
        const mod = await importJobMain();
        process.env.TEST_CONFIGS_JSON = "[not-json";

        expect(() => mod.resolveCustomMatrixFromEnv()).toThrow(/TEST_CONFIGS_JSON/i);
    });

    it("getAzureConfig() defaults location to 'westeurope'", async () => {
        const mod = await importJobMain();

        process.env.AZURE_SUBSCRIPTION_ID = "sub";
        process.env.RESOURCE_GROUP_NAME = "rg";
        delete process.env.AZURE_LOCATION;

        expect(mod.getAzureConfig()).toEqual({
            subscriptionId: "sub",
            resourceGroup: "rg",
            location: "westeurope",
        });
    });

    it("getAzureConfig() throws if required env vars are missing", async () => {
        const mod = await importJobMain();
        process.env.AZURE_SUBSCRIPTION_ID = "sub";
        delete process.env.RESOURCE_GROUP_NAME;

        expect(() => mod.getAzureConfig()).toThrow(/RESOURCE_GROUP_NAME/i);
    });

    it("main() passes custom matrix to OrchestrationService.executeTests and exits 0 on success", async () => {
        const executeTests = jest.fn().mockResolvedValue({
            success: true,
            message: "ok",
            totalExecutions: 1,
            successful: 1,
            failed: 0,
            executions: [],
            timestamp: new Date().toISOString(),
        });

        jest.doMock("../../../src/services/orchestrationService", () => ({
            OrchestrationService: jest.fn().mockImplementation(() => ({ executeTests })),
        }));
        jest.doMock("../../../src/services/configService", () => ({
            ConfigService: jest.fn().mockImplementation(() => ({})),
        }));
        jest.doMock("../../../src/services/containerService", () => ({
            ContainerService: jest.fn().mockImplementation(() => ({})),
        }));

        const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as any);

        process.env.AZURE_SUBSCRIPTION_ID = "sub";
        process.env.RESOURCE_GROUP_NAME = "rg";
        process.env.TEST_CONFIGS_JSON = JSON.stringify([{ env: "qa", platform: "web" }]);

        const mod = await importJobMain();
        await mod.main();

        expect(executeTests).toHaveBeenCalledWith([{ env: "qa", platform: "web" }], console);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("main() passes undefined matrix to OrchestrationService.executeTests and exits 0 on success", async () => {
        const executeTests = jest.fn().mockResolvedValue({
            success: true,
            message: "ok",
            totalExecutions: 4,
            successful: 4,
            failed: 0,
            executions: [],
            timestamp: new Date().toISOString(),
        });

        jest.doMock("../../../src/services/orchestrationService", () => ({
            OrchestrationService: jest.fn().mockImplementation(() => ({ executeTests })),
        }));
        jest.doMock("../../../src/services/configService", () => ({
            ConfigService: jest.fn().mockImplementation(() => ({})),
        }));
        jest.doMock("../../../src/services/containerService", () => ({
            ContainerService: jest.fn().mockImplementation(() => ({})),
        }));

        const exitSpy = jest.spyOn(process, "exit").mockImplementation((() => undefined) as any);

        process.env.AZURE_SUBSCRIPTION_ID = "sub";
        process.env.RESOURCE_GROUP_NAME = "rg";
        delete process.env.TEST_CONFIGS_JSON;

        const mod = await importJobMain();
        await mod.main();

        expect(executeTests).toHaveBeenCalledWith(undefined, console);
        expect(exitSpy).toHaveBeenCalledWith(0);
    });
});
