import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathExists } from "../fs.js";
import { shouldSkip, walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

export async function configSeeds(root: string): Promise<FeatureSeed[]> {
  const candidates = [
    "package.json",
    "tsconfig.json",
    "turbo.json",
    "oxlint.json",
    "vitest.config.ts",
    "go.mod",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "Package.swift",
    "global.json",
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "Directory.Packages.targets",
    "composer.json",
    "composer.lock",
    "phpunit.xml",
    "Makefile",
  ];
  const seeds: FeatureSeed[] = [];
  for (const file of candidates) {
    if (await pathExists(join(root, file))) {
      seeds.push({
        title: `Project config ${file}`,
        summary: `Build, release, or quality configuration in ${file}.`,
        kind: "config",
        source: "shared-infra-heuristic",
        confidence: "medium",
        entryPath: file,
        symbol: null,
        route: null,
        command: null,
        tags: ["config"],
        trustBoundaries: ["process-exec", "filesystem"],
        skipNearbyTests: true,
      });
    }
  }
  const shellAndWorkflowFiles: string[] = [];
  for (const file of await walk(root, [".github/workflows", "scripts", "bin"], shouldSkip)) {
    if (await isShellOrWorkflowFile(root, file)) {
      shellAndWorkflowFiles.push(file);
    }
  }
  shellAndWorkflowFiles.sort();
  for (const file of shellAndWorkflowFiles) {
    seeds.push({
      title: `Shell/workflow config ${basename(file)}`,
      summary: `Shell or workflow automation in ${file}, including command substitutions and machine-readable command output.`,
      kind: "config",
      source: "shell-workflow-heuristic",
      confidence: "medium",
      entryPath: file,
      symbol: null,
      route: null,
      command: null,
      tags: ["config", "shell", "workflow"],
      trustBoundaries: ["process-exec", "filesystem", "network"],
      skipNearbyTests: true,
    });
  }
  return seeds;
}

async function isShellOrWorkflowFile(root: string, path: string): Promise<boolean> {
  if (/\.(?:sh|bash)$/u.test(path)) {
    return true;
  }
  if (path.startsWith(".github/workflows/") && /\.(?:ya?ml)$/u.test(path)) {
    return true;
  }
  if (!path.startsWith("scripts/") && !path.startsWith("bin/")) {
    return false;
  }
  return hasShellShebang(join(root, path));
}

async function hasShellShebang(path: string): Promise<boolean> {
  const handle = await open(path, "r").catch(() => null);
  if (handle === null) {
    return false;
  }
  try {
    const buffer = Buffer.alloc(256);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/u, 1)[0] ?? "";
    return /^#!.*(?:[/\s](?:ba|z|k)?sh)(?:\s|$)/u.test(firstLine);
  } finally {
    await handle.close();
  }
}
