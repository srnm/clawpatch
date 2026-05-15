import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs.js";
import { projectNameFromRoot, discoverGit } from "./git.js";
import { stableId } from "./id.js";
import { ProjectRecord, ProjectCommands } from "./types.js";

type PackageJson = {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  bin?: unknown;
};

export async function detectProject(root: string): Promise<ProjectRecord> {
  const git = await discoverGit(root);
  const pkg = await readPackageJson(root);
  const packageManagers = await detectPackageManagers(root);
  const frameworks = detectFrameworks(pkg);
  const languages = await detectLanguages(root);
  const commands = await detectCommands(root, pkg, languages, packageManagers);
  const name = typeof pkg?.name === "string" ? pkg.name : projectNameFromRoot(root, git.remoteUrl);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    projectId: stableId("prj", [git.remoteUrl ?? root, name]),
    name,
    rootPath: root,
    git: {
      remoteUrl: git.remoteUrl,
      defaultBranch: git.defaultBranch,
      currentBranch: git.currentBranch,
      headSha: git.headSha,
    },
    detected: {
      languages,
      frameworks,
      packageManagers,
      commands,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export async function readPackageJson(root: string): Promise<PackageJson | null> {
  const path = join(root, "package.json");
  if (!(await pathExists(path))) {
    return null;
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
}

export function packageScripts(pkg: PackageJson | null): Record<string, string> {
  if (typeof pkg?.scripts !== "object" || pkg.scripts === null) {
    return {};
  }
  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(pkg.scripts)) {
    if (typeof value === "string") {
      scripts[key] = value;
    }
  }
  return scripts;
}

export function packageBins(pkg: PackageJson | null): Record<string, string> {
  const bin = pkg?.bin;
  if (typeof bin === "string") {
    const name = typeof pkg?.name === "string" ? pkg.name : "bin";
    return { [name]: bin };
  }
  if (typeof bin !== "object" || bin === null) {
    return {};
  }
  const bins: Record<string, string> = {};
  for (const [key, value] of Object.entries(bin)) {
    if (typeof value === "string") {
      bins[key] = value;
    }
  }
  return bins;
}

async function detectCommands(
  root: string,
  pkg: PackageJson | null,
  languages: string[],
  packageManagers: string[],
): Promise<ProjectCommands> {
  const scripts = packageScripts(pkg);
  const defaults = await languageDefaultCommands(root, languages);
  const packageManager = packageScriptManager(packageManagers);
  return {
    typecheck:
      scripts["typecheck"] !== undefined
        ? packageRunCommand(packageManager, "typecheck")
        : defaults.typecheck,
    lint: scripts["lint"] !== undefined ? packageRunCommand(packageManager, "lint") : defaults.lint,
    format:
      scripts["format"] !== undefined
        ? packageRunCommand(packageManager, "format")
        : defaults.format,
    test: scripts["test"] !== undefined ? packageRunCommand(packageManager, "test") : defaults.test,
  };
}

async function languageDefaultCommands(
  root: string,
  languages: string[],
): Promise<ProjectCommands> {
  if (languages.includes("go")) {
    return {
      typecheck: "go test ./...",
      lint: null,
      format: null,
      test: "go test ./...",
    };
  }
  if (languages.includes("rust")) {
    return {
      typecheck: "cargo check --workspace --all-targets",
      lint: null,
      format: "cargo fmt --all --check",
      test: "cargo test --workspace",
    };
  }
  if (languages.includes("swift") && (await pathExists(join(root, "Package.swift")))) {
    return {
      typecheck: "swift build",
      lint: null,
      format: null,
      test: (await hasSwiftTests(root)) ? "swift test" : null,
    };
  }

  return {
    typecheck: null,
    lint: null,
    format: null,
    test: null,
  };
}

function packageScriptManager(packageManagers: string[]): string {
  return packageManagers.find((name) => nodePackageManagers.has(name)) ?? "npm";
}

const nodePackageManagers = new Set(["pnpm", "npm", "yarn", "bun", "node"]);

function packageRunCommand(packageManager: string, script: string): string {
  if (packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${script}`;
  }
  if (packageManager === "bun") {
    return `bun run ${script}`;
  }
  return `npm run ${script}`;
}

async function detectPackageManagers(root: string): Promise<string[]> {
  const found: string[] = [];
  const nodeChecks: Array<[string, string]> = [
    ["pnpm", "pnpm-lock.yaml"],
    ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lockb"],
  ];
  for (const [name, file] of nodeChecks) {
    if ((await pathExists(join(root, file))) && !found.includes(name)) {
      found.push(name);
    }
  }
  if ((await pathExists(join(root, "pnpm-workspace.yaml"))) && !found.includes("pnpm")) {
    found.push("pnpm");
  }
  if (
    !found.some((name) => nodePackageManagers.has(name)) &&
    (await pathExists(join(root, "package.json")))
  ) {
    found.push("node");
  }

  const nativeChecks: Array<[string, string]> = [
    ["cargo", "Cargo.toml"],
    ["swiftpm", "Package.swift"],
  ];
  for (const [name, file] of nativeChecks) {
    if (await pathExists(join(root, file))) {
      found.push(name);
    }
  }
  if (!found.includes("swiftpm") && (await containsFileNamed(root, "Package.swift", 5))) {
    found.push("swiftpm");
  }
  if (
    !found.includes("gradle") &&
    ((await containsFileNamed(root, "settings.gradle", 5)) ||
      (await containsFileNamed(root, "settings.gradle.kts", 5)) ||
      (await containsFileNamed(root, "build.gradle", 5)) ||
      (await containsFileNamed(root, "build.gradle.kts", 5)))
  ) {
    found.push("gradle");
  }
  return found;
}

async function hasSwiftTests(root: string): Promise<boolean> {
  if (!(await pathExists(join(root, "Package.swift")))) {
    return false;
  }
  const manifest = stripSwiftComments(await readFile(join(root, "Package.swift"), "utf8"));
  if (/\.testTarget\s*\(/u.test(manifest)) {
    return true;
  }
  return containsSwiftFile(join(root, "Tests"));
}

async function containsSwiftFile(dir: string): Promise<boolean> {
  if (!(await pathExists(dir))) {
    return false;
  }
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    return false;
  }
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && entry.endsWith(".swift")) {
      return true;
    }
    if (info.isDirectory() && (await containsSwiftFile(full))) {
      return true;
    }
  }
  return false;
}

function detectFrameworks(pkg: PackageJson | null): string[] {
  const deps = dependencyNames(pkg);
  const frameworks: string[] = [];
  for (const name of ["next", "express", "fastify", "hono", "vitest"]) {
    if (deps.has(name)) {
      frameworks.push(name);
    }
  }
  return frameworks;
}

function dependencyNames(pkg: PackageJson | null): Set<string> {
  const names = new Set<string>();
  for (const field of [pkg?.dependencies, pkg?.devDependencies]) {
    if (typeof field !== "object" || field === null) {
      continue;
    }
    for (const name of Object.keys(field)) {
      names.add(name);
    }
  }
  return names;
}

async function detectLanguages(root: string): Promise<string[]> {
  const checks: Array<[string, string]> = [
    ["typescript", "tsconfig.json"],
    ["javascript", "package.json"],
    ["go", "go.mod"],
    ["rust", "Cargo.toml"],
    ["swift", "Package.swift"],
    ["python", "pyproject.toml"],
  ];
  const languages: string[] = [];
  for (const [language, file] of checks) {
    if (await pathExists(join(root, file))) {
      languages.push(language);
    }
  }
  if (
    !languages.includes("swift") &&
    ((await containsFileNamed(root, "Package.swift", 5)) ||
      (await containsFileWithExtension(root, ".swift", 5)))
  ) {
    languages.push("swift");
  }
  if (
    !languages.includes("kotlin") &&
    ((await containsFileWithExtension(root, ".kt", 5)) ||
      (await containsFileWithExtension(root, ".kts", 5)))
  ) {
    languages.push("kotlin");
  }
  return languages;
}

async function containsFileNamed(root: string, name: string, maxDepth: number): Promise<boolean> {
  return containsFileMatching(root, maxDepth, (entry) => entry === name);
}

async function containsFileWithExtension(
  root: string,
  extension: string,
  maxDepth: number,
): Promise<boolean> {
  return containsFileMatching(root, maxDepth, (entry) => entry.endsWith(extension));
}

async function containsFileMatching(
  dir: string,
  remainingDepth: number,
  predicate: (entry: string) => boolean,
): Promise<boolean> {
  if (remainingDepth < 0 || !(await pathExists(dir))) {
    return false;
  }
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return false;
  }
  for (const entry of await readdir(dir)) {
    if (
      [
        "node_modules",
        "dist",
        "build",
        "target",
        ".build",
        ".swiftpm",
        ".git",
        ".clawpatch",
        ".worktrees",
        "fixtures",
        "__fixtures__",
        "testdata",
        "Pods",
        "Carthage",
        "SourcePackages",
        "DerivedData",
      ].includes(entry)
    ) {
      continue;
    }
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && predicate(entry)) {
      return true;
    }
    if (info.isDirectory() && (await containsFileMatching(full, remainingDepth - 1, predicate))) {
      return true;
    }
  }
  return false;
}

function stripLineComments(source: string, marker: "//"): string {
  return source
    .split("\n")
    .map((line) => stripLineComment(line, marker))
    .join("\n");
}

function stripSwiftComments(source: string): string {
  return stripLineComments(stripBlockComments(source), "//");
}

function stripBlockComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      output += "  ";
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          output += "  ";
          depth += 1;
          index += 2;
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          depth -= 1;
          index += 2;
          continue;
        }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index -= 1;
    } else {
      output += char;
    }
  }
  return output;
}

function stripLineComment(line: string, marker: "//"): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (line.startsWith(marker, index)) {
      return line.slice(0, index);
    }
  }
  return line;
}
