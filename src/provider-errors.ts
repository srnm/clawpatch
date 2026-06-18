const authFailure =
  /\b(?:unauthori[sz]ed|(?:wrong|incorrect|invalid|missing|no)[\s_-]+api[\s_-]*key|api[\s_-]*key\s+(?:is\s+)?(?:missing|required|invalid|expired|not[\s_-]+found|not[\s_-]+set)|[A-Z0-9_]*API[_-]?KEY\s+(?:is\s+)?(?:missing|required|invalid|expired|not[\s_-]+set)|not authenticated|auth(?:entication|orization)?[\s_-]*(?:failed|required|missing|error)|login\s+(?:required|failed)|please\s+(?:log\s*in|login)|missing scopes?|insufficient permissions?|api\.responses\.write)\b/iu;
const quotaFailure =
  /\b(?:quota[\s_-]+(?:exceeded|exhausted|reached)|(?:exceeded|exhausted|reached)[\s_-]+(?:your[\s_-]+)?(?:current[\s_-]+)?quota|insufficient[\s_-]+quota|out[\s_-]+of[\s_-]+quota|rate[\s_-]*limit(?:ed|[\s_-]*(?:error|exceeded|reached))|too many requests)\b/iu;
const stderrAuthFailure = /auth|login|api key|unauthorized|wrong api key/iu;
const stderrQuotaFailure = /quota|rate.?limit/iu;

export function providerExitCode(stdout: string, stderr = ""): number {
  if (stderrAuthFailure.test(stderr) || authFailure.test(stdout)) {
    return 4;
  }
  if (stderrQuotaFailure.test(stderr) || quotaFailure.test(stdout)) {
    return 5;
  }
  return 1;
}
