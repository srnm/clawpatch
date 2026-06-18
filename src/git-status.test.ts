import { describe, expect, it } from "vitest";
import { parseGitStatus } from "./git-status.js";

describe("parseGitStatus", () => {
  it("parses ordinary and untracked paths without shell-style decoding", () => {
    expect(parseGitStatus(" M src/a.ts\0?? weird -> name\n.ts\0")).toEqual([
      {
        status: " M",
        primaryPath: "src/a.ts",
        paths: ["src/a.ts"],
      },
      {
        status: "??",
        primaryPath: "weird -> name\n.ts",
        paths: ["weird -> name\n.ts"],
      },
    ]);
  });

  it("preserves both current and original rename paths", () => {
    expect(parseGitStatus("R  new\\name.ts\0old name.ts\0")).toEqual([
      {
        status: "R ",
        primaryPath: "new\\name.ts",
        secondaryPath: "old name.ts",
        paths: ["new\\name.ts", "old name.ts"],
      },
    ]);
  });

  it("ignores malformed and empty records", () => {
    expect(parseGitStatus("bad\0\0 M valid.ts\0")).toEqual([
      {
        status: " M",
        primaryPath: "valid.ts",
        paths: ["valid.ts"],
      },
    ]);
  });
});
