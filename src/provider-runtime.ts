export function providerTimeoutMs(envName: string, defaultMs: number): number {
  const raw = process.env[envName] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  if (raw === undefined) {
    return defaultMs;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}

export function providerCheckTimeoutMs(): number {
  return providerTimeoutMs("CLAWPATCH_PROVIDER_CHECK_TIMEOUT_MS", 10_000);
}
