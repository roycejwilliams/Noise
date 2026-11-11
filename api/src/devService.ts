// The dev test service's Railway name. It was "co-test" and is being renamed "cue-test" (Royce, 2026-11-11); both are accepted so the
// rename never quietly switches off the dev-only paths (the morning review, test-user issue reports, the issues table migration).
export const DEV_SERVICE_NAMES = ["co-test", "cue-test"] as const;
export const isDevService = (name: string | undefined | null): boolean => !!name && (DEV_SERVICE_NAMES as readonly string[]).includes(name);
