import { afterEach, describe, expect, it } from "vitest";
import { providerCheckTimeoutMs, providerTimeoutMs } from "./provider-runtime.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("provider runtime policy", () => {
  it("prefers provider-specific timeout over the global fallback", () => {
    process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"] = "200";
    process.env["CLAWPATCH_TEST_TIMEOUT_MS"] = "100";

    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(100);
    delete process.env["CLAWPATCH_TEST_TIMEOUT_MS"];
    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(200);
  });

  it("uses safe defaults for missing and invalid values", () => {
    delete process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
    process.env["CLAWPATCH_TEST_TIMEOUT_MS"] = "invalid";

    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(300);
    expect(providerCheckTimeoutMs()).toBe(10_000);
  });
});
