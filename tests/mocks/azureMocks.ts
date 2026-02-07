import { AzureConfig } from "../../src/types";


/**
 * Test Mocks for Job-only runtime
 * ------------------------------
 * This project runs as a Container Apps Job (no Azure Functions host).
 *
 * Therefore:
 * - We do NOT mock or depend on "@azure/functions"
 * - We provide a minimal capturing logger for service tests
 * - We provide Azure SDK mocks for Container Apps Jobs and App Configuration
 *
 * ---------------
 * CapturingLogger
 * ---------------
 * A tiny logger that stores logs/warns/errors for assertions in tests.
 *
 * This matches the Logger shape used across services:
 *   { log: (...args) => void, warn: (...args) => void, error: (...args) => void }
 */
export type CapturingLogger = {
    log: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;

    /** Helpers for assertions */
    _getLogs: () => string[];
    _getWarns: () => string[];
    _getErrors: () => any[][];
};

/**
 * createCapturingLogger()
 * -----------------------
 * Use this for unit/integration tests of services.
 *
 * It captures:
 * - log output (as joined strings)
 * - warn output (as joined strings)
 * - error output (as raw arg arrays)
 */
export function createCapturingLogger(): CapturingLogger {
    const logs: string[] = [];
    const warns: string[] = [];
    const errors: any[][] = [];

    return {
        log: jest.fn((...args: any[]) => logs.push(args.join(" "))),
        warn: jest.fn((...args: any[]) => warns.push(args.join(" "))),
        error: jest.fn((...args: any[]) => errors.push(args)),
        _getLogs: () => logs,
        _getWarns: () => warns,
        _getErrors: () => errors,
    };
}

/**
 * createMockContainerAppsApiClient()
 * ---------------------------------
 * Mocks the subset of the Container Apps SDK client used by ContainerService:
 *   client.jobs.beginStartAndWait(resourceGroup, jobName, payload)
 *
 * Tests can override mockResolvedValue/mockRejectedValue per test.
 */
export function createMockContainerAppsApiClient() {
    return {
        jobs: {
            beginStartAndWait: jest.fn().mockResolvedValue({
                name: "exec-test-001",
                id: "/subscriptions/test/resourceGroups/rg/providers/Microsoft.App/jobs/job/executions/exec-test-001",
            }),
        },
    };
}

/**
 * createMockAppConfigurationClient()
 * ---------------------------------
 * App Configuration mock for ConfigService tests.
 *
 * It supports the keys used by ConfigService:
 * - TestMatrix:Environments, TestMatrix:Platforms
 * - Container:Image, Container:CPU, Container:MemoryGB
 * - ContainerApps:JobName
 * - Orchestration:ConcurrencyLimit
 * - Network:* (optional intent)
 */
export function createMockAppConfigurationClient() {
    return {
        getConfigurationSetting: jest.fn().mockImplementation(({ key }: { key: string }) => {
            const settings: Record<string, string> = {
                "TestMatrix:Environments": "prod,qa",
                "TestMatrix:Platforms": "web,mobile",

                "Container:Image": "test.azurecr.io/test:latest",
                "Container:CPU": "1.0",
                "Container:MemoryGB": "2.0",

                "ContainerApps:JobName": "test-orchestrator-job",
                "Orchestration:ConcurrencyLimit": "10",

                "Network:Enabled": "true",
                "Network:VnetName": "Isrotel-Automation-Resources-vnets",
                // Optional keys (left blank by default)
                "Network:SubnetResourceId": "",
                "Network:SubnetName": "",
                "Network:InternalOnly": "false",
            };

            return Promise.resolve({
                key,
                value: settings[key] || "",
            });
        }),
    };
}

/**
 * mockAzureConfig
 * ---------------
 * Matches the AzureConfig shape used by ContainerService:
 * - subscriptionId
 * - resourceGroup
 * - optional location
 */
export const mockAzureConfig: AzureConfig = {
    subscriptionId: "test-subscription-id",
    resourceGroup: "test-rg",
    location: "westeurope",
};