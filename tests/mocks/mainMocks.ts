// tests/helpers/mainMock.ts
//
// mainMock helper for tests.
// Loads src/job/main.ts and returns a normalized module object.
//
// Why:
/// - Different TS/Jest setups may expose exports differently (ESM vs CJS).
// - This helper makes tests stable by normalizing:
//     - named exports: mod.main
//     - default export: mod.default.main

export type JobMainModule = {
    main: (...args: any[]) => Promise<void> | void;
    resolveCustomMatrixFromEnv: (...args: any[]) => any;
    getAzureConfig: (...args: any[]) => any;
    requireEnv: (...args: any[]) => any;
};

export async function importJobMain(): Promise<JobMainModule> {
    const imported: any = await import("../../src/job/main");

    // Normalize both ESM and CJS export shapes
    const mod: any = imported?.default ?? imported;

    // Provide a clear error if something is missing (helps debugging)
    const required = ["main", "resolveCustomMatrixFromEnv", "getAzureConfig", "requireEnv"] as const;
    for (const key of required) {
        if (typeof mod[key] !== "function") {
            throw new Error(
                `mainMock: Expected '${key}' to be a function export from src/job/main.ts, but got: ${typeof mod[key]}`
            );
        }
    }

    return mod as JobMainModule;
}
