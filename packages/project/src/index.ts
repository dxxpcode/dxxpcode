import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";

export interface ProjectInfo {
  root: string;
  name: string;
  languages: string[];
  packageManager: string | null;
  testCommand: string | null;
  buildCommand: string | null;
  git: GitInfo | null;
}

export interface GitInfo {
  branch: string;
  dirty: boolean;
  aheadBehind: string | null;
}

interface Marker {
  file: string;
  language: string;
  packageManager?: string;
  test?: string;
  build?: string;
}

const MARKERS: Marker[] = [
  { file: "package.json", language: "JavaScript/TypeScript" },
  { file: "pyproject.toml", language: "Python", test: "pytest" },
  { file: "requirements.txt", language: "Python" },
  { file: "Cargo.toml", language: "Rust", test: "cargo test", build: "cargo build" },
  { file: "go.mod", language: "Go", test: "go test ./...", build: "go build ./..." },
  { file: "pom.xml", language: "Java", test: "mvn test", build: "mvn compile" },
  { file: "build.gradle", language: "Java/Kotlin", test: "./gradlew test", build: "./gradlew build" },
];

const PM_LOCKFILES: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

function detectJsPackageManager(root: string): string {
  for (const [lockfile, pm] of PM_LOCKFILES) {
    if (existsSync(join(root, lockfile))) return pm;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (typeof pkg.packageManager === "string") return pkg.packageManager.split("@")[0];
  } catch {
    /* fall through */
  }
  return "npm";
}

function detectJsCommands(root: string, pm: string): { test: string | null; build: string | null } {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const scripts = pkg.scripts ?? {};
    const run = pm === "npm" ? "npm run" : pm === "yarn" ? "yarn" : `${pm} run`;
    const test = pm === "npm" ? "npm test" : `${pm} test`;
    return {
      test: scripts.test ? test : null,
      build: scripts.build ? `${run} build` : null,
    };
  } catch {
    return { test: null, build: null };
  }
}

export function detectGit(root: string): GitInfo | null {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let aheadBehind: string | null = null;
    try {
      aheadBehind = execFileSync(
        "git",
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      /* no upstream */
    }
    return { branch, dirty: status.trim().length > 0, aheadBehind };
  } catch {
    return null;
  }
}

export function detectProject(root: string): ProjectInfo {
  const languages = new Set<string>();
  let packageManager: string | null = null;
  let testCommand: string | null = null;
  let buildCommand: string | null = null;

  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    /* unreadable dir */
  }
  const hasCsproj = entries.some((e) => e.endsWith(".csproj"));

  for (const marker of MARKERS) {
    if (existsSync(join(root, marker.file))) {
      languages.add(marker.language);
      if (marker.file === "package.json") {
        packageManager = detectJsPackageManager(root);
        const cmds = detectJsCommands(root, packageManager);
        testCommand = cmds.test;
        buildCommand = cmds.build;
      } else {
        testCommand = testCommand ?? marker.test ?? null;
        buildCommand = buildCommand ?? marker.build ?? null;
      }
    }
  }
  if (hasCsproj) {
    languages.add(".NET");
    testCommand = testCommand ?? "dotnet test";
    buildCommand = buildCommand ?? "dotnet build";
  }

  return {
    root,
    name: basename(root),
    languages: [...languages],
    packageManager,
    testCommand,
    buildCommand,
    git: detectGit(root),
  };
}

export const PROJECT_DIR_NAME = ".dxxpcode";

/**
 * Load project instructions. `.dxxpcode/instructions.md` wins; `AGENTS.md`
 * at the root is honored as a fallback convention.
 */
export function loadInstructions(root: string): { path: string; content: string } | null {
  const candidates = [
    join(root, PROJECT_DIR_NAME, "instructions.md"),
    join(root, "AGENTS.md"),
  ];
  for (const path of candidates) {
    if (existsSync(path) && statSync(path).isFile()) {
      try {
        const content = readFileSync(path, "utf8").trim();
        if (content) return { path, content };
      } catch {
        /* unreadable */
      }
    }
  }
  return null;
}

/** Shallow listing of top-level entries for the context snapshot. */
export function topLevelListing(root: string, max = 60): string[] {
  const SKIP = new Set(["node_modules", ".git", "dist", "build", "target", "__pycache__", ".next", ".venv", "venv"]);
  try {
    return readdirSync(root)
      .filter((e) => !SKIP.has(e))
      .slice(0, max);
  } catch {
    return [];
  }
}
