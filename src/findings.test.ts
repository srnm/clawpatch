import { describe, expect, it } from "vitest";
import { findingFromOutput } from "./findings.js";
import type { ReviewOutput } from "./types.js";

describe("findingFromOutput", () => {
  it("keeps signatures stable for equivalent evidence with different key insertion order", () => {
    const orderedEvidence = {
      path: "src/app.ts",
      startLine: 10,
      endLine: 12,
      symbol: "runWorkflow",
      quote: "await runWorkflow();",
    };
    const reorderedEvidence = {} as Record<string, unknown>;
    reorderedEvidence["quote"] = "await runWorkflow();";
    reorderedEvidence["symbol"] = "runWorkflow";
    reorderedEvidence["endLine"] = 12;
    reorderedEvidence["startLine"] = 10;
    reorderedEvidence["path"] = "src/app.ts";

    const first = findingFromOutput(finding([orderedEvidence]), "feature_1", "run_1");
    const second = findingFromOutput(
      finding([reorderedEvidence as ReviewOutput["findings"][number]["evidence"][number]]),
      "feature_1",
      "run_1",
    );

    expect(second.signature).toBe(first.signature);
    expect(second.findingId).toBe(first.findingId);
  });

  it("keeps signatures stable for equivalent evidence with different reference order", () => {
    const first = findingFromOutput(
      finding([
        {
          path: "src/app.ts",
          startLine: 10,
          endLine: 12,
          symbol: "runWorkflow",
          quote: "await runWorkflow();",
        },
        {
          path: "src/provider.ts",
          startLine: 20,
          endLine: 22,
          symbol: null,
          quote: null,
        },
      ]),
      "feature_1",
      "run_1",
    );
    const second = findingFromOutput(
      finding([
        {
          path: "src/provider.ts",
          startLine: 20,
          endLine: 22,
          symbol: null,
          quote: null,
        },
        {
          path: "src/app.ts",
          startLine: 10,
          endLine: 12,
          symbol: "runWorkflow",
          quote: "await runWorkflow();",
        },
      ]),
      "feature_1",
      "run_1",
    );

    expect(second.signature).toBe(first.signature);
    expect(second.findingId).toBe(first.findingId);
  });

  it("keeps signatures distinct when evidence content changes", () => {
    const first = findingFromOutput(
      finding([
        {
          path: "src/app.ts",
          startLine: 10,
          endLine: 12,
          symbol: "runWorkflow",
          quote: "await runWorkflow();",
        },
      ]),
      "feature_1",
      "run_1",
    );
    const second = findingFromOutput(
      finding([
        {
          path: "src/app.ts",
          startLine: 10,
          endLine: 12,
          symbol: "runWorkflow",
          quote: "await runWorkflowSafely();",
        },
      ]),
      "feature_1",
      "run_1",
    );

    expect(second.signature).not.toBe(first.signature);
    expect(second.findingId).not.toBe(first.findingId);
  });
});

function finding(
  evidence: ReviewOutput["findings"][number]["evidence"],
): ReviewOutput["findings"][number] {
  return {
    title: "Finding title",
    category: "bug",
    severity: "medium",
    confidence: "high",
    evidence,
    reasoning: "Reasoning.",
    reproduction: null,
    recommendation: "Recommendation.",
    whyTestsDoNotAlreadyCoverThis: "No regression coverage exists.",
    suggestedRegressionTest: null,
    minimumFixScope: "Keep the fix narrow.",
  };
}
