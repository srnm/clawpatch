import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
import { partitionFileGroups } from "./grouping.js";
import { isSampleProjectPath, normalize, pathMatchesPrefix, shouldSkip, walk } from "./shared.js";
import { FeatureSeed, SeedTestRef } from "./types.js";

const maxOwnedFiles = 12;
const maxTests = 8;

export async function appleSeeds(root: string): Promise<FeatureSeed[]> {
  const projectRoots = await discoverAppleProjectRoots(root);
  const seeds: FeatureSeed[] = [];
  for (const projectRoot of projectRoots) {
    seeds.push(...(await appleProjectSeeds(root, projectRoot)));
  }
  return seeds;
}

async function appleProjectSeeds(root: string, projectRoot: string): Promise<FeatureSeed[]> {
  const manifest = await appleProjectManifest(root, projectRoot);
  if (manifest === null) {
    return [];
  }
  const prefixes = await appleReviewPrefixes(root, projectRoot);
  const allFiles = await walk(root, prefixes);
  const swiftFiles = allFiles
    .filter((file) => file.endsWith(".swift"))
    .filter((file) => !isApplePackageManifest(projectRoot, file))
    .filter((file) => !isAppleVendoredOrGeneratedFile(projectRoot, file))
    .filter((file) => !isAppleTestFile(projectRoot, file));
  const testFiles = allFiles
    .filter((file) => file.endsWith(".swift"))
    .filter((file) => !isAppleVendoredOrGeneratedFile(projectRoot, file))
    .filter((file) => isAppleTestFile(projectRoot, file));
  const seeds: FeatureSeed[] = [
    {
      title: `Apple project ${projectRoot}`,
      summary: `Apple/Xcode project rooted at ${projectRoot}.`,
      kind: "ui-flow",
      source: "apple-project",
      confidence: "medium",
      entryPath: manifest,
      symbol: projectRoot,
      route: null,
      command: null,
      ownedFiles: [{ path: manifest, reason: "project manifest" }],
      contextFiles: await appleContextFiles(root, projectRoot),
      tags: ["apple", "swift", "xcode"],
      trustBoundaries: ["filesystem"],
      skipNearbyTests: true,
    },
  ];

  for (const bucket of appleSourceBuckets(projectRoot, swiftFiles)) {
    for (const group of partitionFileGroups(bucket.label, bucket.files, maxOwnedFiles)) {
      const tests = associatedSwiftTests(group.files, testFiles);
      seeds.push({
        title: `Apple source ${group.label}`,
        summary: `Apple Swift source group ${group.label} with ${group.files.length} files.`,
        kind: "ui-flow",
        source: "apple-source-group",
        confidence: "medium",
        entryPath: manifest,
        symbol: group.label,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `apple source group ${group.label}`,
        })),
        contextFiles: tests.map((test) => ({ path: test.path, reason: "associated apple test" })),
        tests,
        tags: ["apple", "swift", "xcode"],
        trustBoundaries: ["filesystem"],
        skipNearbyTests: true,
      });
    }
  }

  if (testFiles.length > 0) {
    for (const group of partitionFileGroups(projectRoot, testFiles, maxOwnedFiles)) {
      seeds.push({
        title: `Apple test suite ${group.label}`,
        summary: `Apple Swift test group ${group.label} with ${group.files.length} files.`,
        kind: "test-suite",
        source: "apple-test-group",
        confidence: "medium",
        entryPath: group.files[0] ?? manifest,
        symbol: group.label,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `apple test group ${group.label}`,
        })),
        tags: ["apple", "swift", "test"],
        trustBoundaries: [],
        skipNearbyTests: true,
      });
    }
  }

  return seeds;
}

async function appleReviewPrefixes(root: string, projectRoot: string): Promise<string[]> {
  const dir = projectRoot === "." ? root : join(root, projectRoot);
  const prefixes: string[] = [];
  for (const entry of await readdir(dir)) {
    const child = projectRoot === "." ? entry : `${projectRoot}/${entry}`;
    if (!isSampleProjectPath(child) && !isAppleVendoredOrGeneratedPath(child)) {
      prefixes.push(child);
    }
  }
  return prefixes;
}

async function discoverAppleProjectRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  await discoverAppleProjectRootsInto(root, ".", 5, roots);
  return [...new Set(roots)].toSorted();
}

async function discoverAppleProjectRootsInto(
  root: string,
  dir: string,
  remainingDepth: number,
  roots: string[],
): Promise<void> {
  if (remainingDepth < 0 || (dir !== "." && (shouldSkip(dir) || isSampleProjectPath(dir)))) {
    return;
  }
  const full = dir === "." ? root : join(root, dir);
  if (!(await pathExists(full))) {
    return;
  }
  const info = await lstat(full);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return;
  }
  if (await hasAppleProjectManifest(full)) {
    roots.push(dir);
  }
  for (const entry of await readdir(full)) {
    const child = dir === "." ? entry : `${dir}/${entry}`;
    if (shouldSkip(child) || isSampleProjectPath(child) || isAppleVendoredOrGeneratedPath(child)) {
      continue;
    }
    const childInfo = await lstat(join(full, entry));
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      await discoverAppleProjectRootsInto(root, child, remainingDepth - 1, roots);
    }
  }
}

function isAppleVendoredOrGeneratedFile(projectRoot: string, file: string): boolean {
  const relativePath = normalize(file).slice(projectRoot === "." ? 0 : projectRoot.length + 1);
  return isAppleVendoredOrGeneratedPath(relativePath);
}

function isApplePackageManifest(projectRoot: string, file: string): boolean {
  const relativePath = normalize(file).slice(projectRoot === "." ? 0 : projectRoot.length + 1);
  return relativePath === "Package.swift";
}

function isAppleVendoredOrGeneratedPath(path: string): boolean {
  return path
    .split("/")
    .some((part) =>
      ["Pods", "Carthage", "SourcePackages", "DerivedData", "Generated", "generated"].includes(
        part,
      ),
    );
}

async function hasAppleProjectManifest(dir: string): Promise<boolean> {
  if (await pathExists(join(dir, "project.yml"))) {
    return true;
  }
  for (const entry of await readdir(dir)) {
    if (entry.endsWith(".xcodeproj") || entry.endsWith(".xcworkspace")) {
      return true;
    }
  }
  return false;
}

async function appleProjectManifest(root: string, projectRoot: string): Promise<string | null> {
  const dir = projectRoot === "." ? root : join(root, projectRoot);
  const projectYml = projectRoot === "." ? "project.yml" : `${projectRoot}/project.yml`;
  if (await pathExists(join(root, projectYml))) {
    return projectYml;
  }
  const manifest = (await readdir(dir))
    .filter((entry) => entry.endsWith(".xcodeproj") || entry.endsWith(".xcworkspace"))
    .toSorted(
      (left, right) =>
        appleManifestRank(left) - appleManifestRank(right) || left.localeCompare(right),
    )[0];
  return manifest === undefined
    ? null
    : projectRoot === "."
      ? manifest
      : `${projectRoot}/${manifest}`;
}

function appleManifestRank(path: string): number {
  return path.endsWith(".xcworkspace") ? 0 : 1;
}

async function appleContextFiles(
  root: string,
  projectRoot: string,
): Promise<Array<{ path: string; reason: string }>> {
  const candidates = ["AGENTS.md", "README.md"].map((file) =>
    projectRoot === "." ? file : `${projectRoot}/${file}`,
  );
  const refs: Array<{ path: string; reason: string }> = [];
  for (const candidate of candidates) {
    if (await pathExists(join(root, candidate))) {
      refs.push({ path: candidate, reason: "apple project context" });
    }
  }
  return refs;
}

function associatedSwiftTests(files: string[], testFiles: string[]): SeedTestRef[] {
  const stems = new Set(files.map((file) => basename(file).replace(/\.swift$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  return testFiles
    .filter((test) => {
      const testStem = basename(test)
        .replace(/Tests?\.swift$/u, "")
        .replace(/\.swift$/u, "");
      return stems.has(testStem) || [...dirs].some((dir) => pathMatchesPrefix(test, dir));
    })
    .slice(0, maxTests)
    .map((path) => ({ path, command: null }));
}

function appleSourceBuckets(
  projectRoot: string,
  files: string[],
): Array<{ label: string; files: string[] }> {
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const relativePath = normalize(file).slice(projectRoot === "." ? 0 : projectRoot.length + 1);
    const topLevel = relativePath.split("/").at(0);
    const label =
      topLevel === undefined || topLevel.length === 0
        ? projectRoot
        : projectRoot === "."
          ? topLevel
          : `${projectRoot}/${topLevel}`;
    const bucket = buckets.get(label) ?? [];
    bucket.push(file);
    buckets.set(label, bucket);
  }
  return [...buckets.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([label, bucketFiles]) => ({ label, files: bucketFiles.toSorted() }));
}

function isAppleTestFile(projectRoot: string, file: string): boolean {
  const relativePath = normalize(file).slice(projectRoot === "." ? 0 : projectRoot.length + 1);
  return (
    pathMatchesPrefix(relativePath, "Tests") ||
    pathMatchesPrefix(relativePath, "UITests") ||
    /(^|\/)[^/]+Tests\//u.test(relativePath) ||
    /Tests?\.swift$/u.test(relativePath)
  );
}
