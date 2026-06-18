import type {
  AgentMapOutput,
  CodexConfig,
  FixPlanOutput,
  ReasoningEffort,
  RevalidateOutput,
  ReviewFinding,
  reviewInspectedSchema,
} from "./types.js";
import type { z } from "zod";

export type ProviderOptions = {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  codexConfig?: CodexConfig;
  skipGitRepoCheck: boolean;
};

export type DroppedFinding = {
  path: (string | number)[];
  message: string;
  sample: string;
  layer?: "schema" | "validation" | "registry-verifier";
};

export type PartitionedReviewOutput = {
  findings: ReviewFinding[];
  inspected: z.infer<typeof reviewInspectedSchema>;
  droppedFindings: DroppedFinding[];
};

export type Provider = {
  name: string;
  check(root: string): Promise<string>;
  map(root: string, prompt: string, options: ProviderOptions): Promise<AgentMapOutput>;
  review(root: string, prompt: string, options: ProviderOptions): Promise<PartitionedReviewOutput>;
  fix(root: string, prompt: string, options: ProviderOptions): Promise<FixPlanOutput>;
  revalidate(root: string, prompt: string, options: ProviderOptions): Promise<RevalidateOutput>;
};
