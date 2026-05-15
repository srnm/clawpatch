import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
import { partitionFileGroups } from "./grouping.js";
import { isSampleProjectPath, normalize, pathMatchesPrefix, shouldSkip, walk } from "./shared.js";
import { FeatureSeed, SeedTestRef } from "./types.js";

const maxOwnedFiles = 12;
const maxTests = 8;

export async function gradleSeeds(root: string): Promise<FeatureSeed[]> {
  const roots = await discoverGradleRoots(root);
  const seeds: FeatureSeed[] = [];
  for (const gradleRoot of roots) {
    seeds.push(...(await gradleProjectSeeds(root, gradleRoot)));
  }
  return seeds;
}

async function gradleProjectSeeds(root: string, gradleRoot: string): Promise<FeatureSeed[]> {
  const moduleRoots = await gradleModuleRoots(root, gradleRoot);
  const seeds: FeatureSeed[] = [];
  for (const moduleRoot of moduleRoots) {
    const buildFile = await gradleBuildFile(root, moduleRoot);
    if (buildFile === null) {
      continue;
    }
    const sourceRoot = moduleRoot === "." ? "src" : `${moduleRoot}/src`;
    const sourceFiles = (await walk(root, [sourceRoot]))
      .filter(isGradleSourceFile)
      .filter((file) => !isGradleTestFile(moduleRoot, file));
    const testFiles = (await walk(root, [sourceRoot]))
      .filter(isGradleSourceFile)
      .filter((file) => isGradleTestFile(moduleRoot, file));
    const tags = gradleTags(buildFile, sourceFiles);

    seeds.push({
      title: `Gradle module ${moduleRoot}`,
      summary: `Gradle module rooted at ${moduleRoot}.`,
      kind: tags.includes("android") ? "ui-flow" : "library",
      source: "gradle-module",
      confidence: "medium",
      entryPath: buildFile,
      symbol: moduleRoot,
      route: null,
      command: null,
      ownedFiles: [{ path: buildFile, reason: "gradle build file" }],
      contextFiles: await gradleContextFiles(root, moduleRoot),
      tags,
      trustBoundaries: ["filesystem", "process-exec"],
      skipNearbyTests: true,
    });

    for (const group of partitionFileGroups(sourceRoot, sourceFiles, maxOwnedFiles)) {
      const tests = associatedGradleTests(group.files, testFiles);
      seeds.push({
        title: `Gradle source ${group.label}`,
        summary: `Gradle source group ${group.label} with ${group.files.length} files.`,
        kind: tags.includes("android") ? "ui-flow" : "library",
        source: "gradle-source-group",
        confidence: "medium",
        entryPath: buildFile,
        symbol: group.label,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `gradle source group ${group.label}`,
        })),
        contextFiles: tests.map((test) => ({ path: test.path, reason: "associated gradle test" })),
        tests,
        tags,
        trustBoundaries: ["filesystem", "process-exec"],
        skipNearbyTests: true,
      });
    }

    if (testFiles.length > 0) {
      for (const group of partitionFileGroups(sourceRoot, testFiles, maxOwnedFiles)) {
        seeds.push({
          title: `Gradle test suite ${group.label}`,
          summary: `Gradle test group ${group.label} with ${group.files.length} files.`,
          kind: "test-suite",
          source: "gradle-test-group",
          confidence: "medium",
          entryPath: group.files[0] ?? buildFile,
          symbol: group.label,
          route: null,
          command: null,
          ownedFiles: group.files.map((path) => ({
            path,
            reason: `gradle test group ${group.label}`,
          })),
          tags: [...tags, "test"],
          trustBoundaries: [],
          skipNearbyTests: true,
        });
      }
    }
  }
  return seeds;
}

async function discoverGradleRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  await discoverGradleRootsInto(root, ".", 5, roots);
  return roots.toSorted();
}

async function discoverGradleRootsInto(
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
  const hasSettings =
    (await pathExists(join(full, "settings.gradle"))) ||
    (await pathExists(join(full, "settings.gradle.kts")));
  if (hasSettings || (await gradleBuildFile(root, dir)) !== null) {
    roots.push(dir);
  }
  if (hasSettings) {
    return;
  }
  for (const entry of await readdir(full)) {
    const child = dir === "." ? entry : `${dir}/${entry}`;
    if (shouldSkip(child) || isSampleProjectPath(child)) {
      continue;
    }
    const childInfo = await lstat(join(full, entry));
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      await discoverGradleRootsInto(root, child, remainingDepth - 1, roots);
    }
  }
}

async function gradleModuleRoots(root: string, gradleRoot: string): Promise<string[]> {
  const modules = new Set<string>([gradleRoot]);
  await collectGradleModules(root, gradleRoot, 3, modules);
  return [...modules].toSorted();
}

async function collectGradleModules(
  root: string,
  dir: string,
  remainingDepth: number,
  modules: Set<string>,
): Promise<void> {
  if (remainingDepth < 0 || shouldSkip(dir) || isSampleProjectPath(dir)) {
    return;
  }
  const full = dir === "." ? root : join(root, dir);
  for (const entry of await readdir(full)) {
    const child = dir === "." ? entry : `${dir}/${entry}`;
    if (shouldSkip(child) || isSampleProjectPath(child)) {
      continue;
    }
    const childFull = join(full, entry);
    const childInfo = await lstat(childFull);
    if (!childInfo.isDirectory() || childInfo.isSymbolicLink()) {
      continue;
    }
    if ((await gradleBuildFile(root, child)) !== null) {
      modules.add(child);
    }
    await collectGradleModules(root, child, remainingDepth - 1, modules);
  }
}

async function gradleBuildFile(root: string, moduleRoot: string): Promise<string | null> {
  for (const file of ["build.gradle.kts", "build.gradle"]) {
    const path = moduleRoot === "." ? file : `${moduleRoot}/${file}`;
    if (await pathExists(join(root, path))) {
      return path;
    }
  }
  return null;
}

async function gradleContextFiles(
  root: string,
  moduleRoot: string,
): Promise<Array<{ path: string; reason: string }>> {
  const candidates = ["AGENTS.md", "README.md", "src/main/AndroidManifest.xml"].map((file) =>
    moduleRoot === "." ? file : `${moduleRoot}/${file}`,
  );
  const refs: Array<{ path: string; reason: string }> = [];
  for (const candidate of candidates) {
    if (await pathExists(join(root, candidate))) {
      refs.push({ path: candidate, reason: "gradle module context" });
    }
  }
  return refs;
}

function associatedGradleTests(files: string[], testFiles: string[]): SeedTestRef[] {
  const stems = new Set(files.map((file) => basename(file).replace(/\.[^.]+$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  return testFiles
    .filter((test) => {
      const stem = basename(test)
        .replace(/\.[^.]+$/u, "")
        .replace(/(?:Test|Spec)$/u, "");
      return stems.has(stem) || [...dirs].some((dir) => pathMatchesPrefix(test, dir));
    })
    .slice(0, maxTests)
    .map((path) => ({ path, command: null }));
}

function gradleTags(buildFile: string, sourceFiles: string[]): string[] {
  const tags = ["gradle"];
  if (
    buildFile.endsWith(".kts") ||
    sourceFiles.some((file) => file.endsWith(".kt") || file.endsWith(".kts"))
  ) {
    tags.push("kotlin");
  }
  if (
    sourceFiles.some((file) => file.endsWith("AndroidManifest.xml")) ||
    buildFile.includes("android")
  ) {
    tags.push("android");
  }
  return tags;
}

function isGradleSourceFile(path: string): boolean {
  const normalized = normalize(path);
  return (
    /\.(kt|kts|java|xml)$/u.test(normalized) &&
    /(^|\/)src\//u.test(normalized) &&
    !/(^|\/)(build|generated|intermediates)(\/|$)/u.test(normalized)
  );
}

function isGradleTestFile(moduleRoot: string, path: string): boolean {
  const relativePath = normalize(path).slice(moduleRoot === "." ? 0 : moduleRoot.length + 1);
  return (
    pathMatchesPrefix(relativePath, "src/test") ||
    pathMatchesPrefix(relativePath, "src/androidTest")
  );
}
