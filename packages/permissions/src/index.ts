export type PermissionLevel = "safe" | "approval" | "restricted";

export interface PermissionDecision {
  level: PermissionLevel;
  reason: string;
}

/**
 * Path segments / file names that are never readable or writable by the agent.
 * Applied to both basename matches and any path segment (e.g. `.ssh`).
 */
const RESTRICTED_SEGMENTS = new Set([".ssh", ".aws", ".gnupg", ".password-store", ".docker"]);

const RESTRICTED_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^(credentials|secrets|htpasswd|netrc|\.netrc|shadow)$/i,
  /\.credentials$/i,
  /^config\.(npmrc|dockercfg)$/i,
  /^\.npmrc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
];

/** Manifests / infra config that require approval to modify. */
const APPROVAL_FILE_PATTERNS: RegExp[] = [
  /^package(-lock)?\.json$/,
  /^(pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/,
  /^tsconfig.*\.json$/,
  /\.(config|rc)\.(js|ts|mjs|cjs|json|yaml|yml)$/,
  /^Dockerfile.*$/,
  /^docker-compose.*\.(yaml|yml)$/,
  /^Makefile$/,
  /^Cargo\.(toml|lock)$/,
  /^pyproject\.toml$/,
  /^(go\.mod|go\.sum)$/,
  /^(pom\.xml|build\.gradle.*|.*\.csproj)$/,
  /^\.(github|gitlab|vscode|idea)(\/|$)/,
  /^\.(gitignore|gitattributes|editorconfig|npmrc|nvmrc|node-version)$/,
  /^\.pre-commit-config\.yaml$/,
  /^LICENSE$/,
];

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** Resolve `target` against `root` and return the project-relative path, or null if it escapes. */
export function resolveWithinRoot(root: string, target: string): string | null {
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  const winAbs = /^[a-zA-Z]:[\\/]/.test(target);
  const joined = normalizePath(
    target.startsWith("/") || winAbs ? target : `${normalizedRoot}/${target}`,
  );
  // Resolve . and .. segments.
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  // Keep the root's leading-slash shape: Windows roots ("C:/x") have none.
  const resolved = (joined.startsWith("/") ? "/" : "") + parts.join("/");
  if (resolved === normalizedRoot) return "";
  if (resolved.startsWith(normalizedRoot + "/")) return resolved.slice(normalizedRoot.length + 1);
  return null;
}

export function isRestrictedPath(relativePath: string): boolean {
  const rel = normalizePath(relativePath);
  const segments = rel.split("/").filter(Boolean);
  for (const seg of segments) {
    if (RESTRICTED_SEGMENTS.has(seg.toLowerCase())) return true;
  }
  const base = segments[segments.length - 1] ?? rel;
  return RESTRICTED_FILE_PATTERNS.some((re) => re.test(base));
}

export type FileAction = "read" | "write" | "delete" | "rename";

export function evaluateFileAction(root: string, target: string, action: FileAction): PermissionDecision {
  const rel = resolveWithinRoot(root, target);
  if (rel === null) {
    return { level: "restricted", reason: `Path escapes the project root: ${target}` };
  }
  if (isRestrictedPath(rel)) {
    return { level: "restricted", reason: `Protected file: ${rel} matches a credential/secret pattern` };
  }
  if (action === "delete" || action === "rename") {
    return { level: "approval", reason: `${action} requires confirmation: ${rel}` };
  }
  if (action === "write" && APPROVAL_FILE_PATTERNS.some((re) => re.test(rel))) {
    return { level: "approval", reason: `${rel} is a project manifest/config file` };
  }
  return { level: "safe", reason: `${action} ${rel || "project root"}` };
}

/* ------------------------------ commands ------------------------------ */

interface CommandRule {
  pattern: RegExp;
  level: PermissionLevel;
  reason: string;
}

const RESTRICTED_COMMANDS: CommandRule[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?\/($|\s)/, level: "restricted", reason: "Recursive delete of a filesystem root" },
  { pattern: /\bmkfs\b|\bformat\b.*\/dev\//, level: "restricted", reason: "Filesystem formatting" },
  { pattern: /\bdd\b.*\bof=\/dev\//, level: "restricted", reason: "Raw disk write" },
  { pattern: /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;:/, level: "restricted", reason: "Fork bomb" },
  { pattern: />\s*~?\/?\.ssh\/|cat\s+[^|]*\.ssh\/|cat\s+[^|]*\.env\b/, level: "restricted", reason: "Accesses a protected credential path" },
];

const SAFE_COMMAND_PREFIXES = [
  // inspection
  "ls", "pwd", "cat", "head", "tail", "wc", "file", "stat", "find",
  "grep", "rg", "fd", "tree", "which", "echo", "env", "printenv",
  // git read-only
  "git status", "git diff", "git log", "git show", "git branch",
  "git remote", "git blame", "git rev-parse", "git ls-files", "git describe",
  "git stash list", "git tag", "git config --get", "git config --list",
  // build / test
  "node", "npm test", "npm run", "npm exec", "npm ls", "npm view", "npm outdated",
  "npx tsc", "npx vitest run", "npx jest",
  "pnpm test", "pnpm run", "pnpm exec", "pnpm ls", "pnpm view",
  "yarn test", "yarn run",
  "bun test", "bun run", "bunx",
  "tsc", "vitest", "jest", "mocha", "eslint", "biome", "prettier",
  "cargo test", "cargo build", "cargo check", "cargo clippy", "cargo fmt",
  "go test", "go build", "go vet", "go fmt", "go mod verify",
  "pytest", "python -m pytest", "python -m compileall", "ruff", "mypy",
  "mvn test", "mvn compile", "gradle test", "./gradlew test", "./gradlew build",
  "dotnet test", "dotnet build",
  "make test", "make check", "make build",
  "test", "true", "false",
];

const APPROVAL_COMMANDS: CommandRule[] = [
  { pattern: /\brm\b/, level: "approval", reason: "Deletes files" },
  { pattern: /\bmv\b/, level: "approval", reason: "Moves/renames files" },
  { pattern: /\bcp\s+-[a-zA-Z]*r/, level: "approval", reason: "Recursive copy" },
  { pattern: /\b(git\s+)?(commit|push|reset|clean|rebase|merge|checkout\s+-[bB]|branch\s+-[dD]|stash\s+(pop|drop)|cherry-pick|revert|tag\s+-[dD])\b/, level: "approval", reason: "Mutates git state" },
  { pattern: /\bgit\s+(add|commit|push|pull|fetch|reset|clean|rebase|merge|checkout|switch|restore|stash|cherry-pick|revert|rm|mv)\b/, level: "approval", reason: "Mutates git state" },
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(i|install|add|remove|uninstall|update|upgrade|publish|link)\b/, level: "approval", reason: "Changes dependencies" },
  { pattern: /\b(pip|pip3|uv|poetry)\s+(install|uninstall|add|remove)\b/, level: "approval", reason: "Changes dependencies" },
  { pattern: /\bcargo\s+(add|remove|install|publish)\b/, level: "approval", reason: "Changes dependencies" },
  { pattern: /\bgo\s+(get|install)\b/, level: "approval", reason: "Changes dependencies" },
  { pattern: /\b(sudo|doas)\b/, level: "approval", reason: "Elevated privileges" },
  { pattern: /\b(curl|wget)\b/, level: "approval", reason: "Network access" },
  { pattern: /\|\s*(sh|bash|zsh|fish|python|node)\b/, level: "approval", reason: "Pipes to an interpreter" },
  { pattern: /\b(chmod|chown|chgrp)\b/, level: "approval", reason: "Changes file permissions" },
  { pattern: /\b(docker|podman|kubectl|helm|terraform|ansible)\b/, level: "approval", reason: "Infrastructure access" },
  { pattern: /\b(kill|pkill|killall)\b/, level: "approval", reason: "Terminates processes" },
  { pattern: /\b(apt|apt-get|brew|dnf|yum|pacman|snap)\s+(install|remove|uninstall)\b/, level: "approval", reason: "System package change" },
  { pattern: /\b(launchctl|systemctl|service)\b/, level: "approval", reason: "Service management" },
  { pattern: /\b(sh|bash|zsh|fish)\s+-c\b/, level: "approval", reason: "Shell wrapper" },
  { pattern: />\s*[^|]/, level: "approval", reason: "Writes to a file via redirection" },
  { pattern: /\bssh\b|\bscp\b|\brsync\b/, level: "approval", reason: "Remote access" },
];

export function evaluateCommand(command: string): PermissionDecision {
  const cmd = command.trim();
  for (const rule of RESTRICTED_COMMANDS) {
    if (rule.pattern.test(cmd)) return { level: rule.level, reason: rule.reason };
  }
  // Restricted-path arguments deny the whole command.
  for (const token of cmd.split(/\s+/)) {
    const cleaned = token.replace(/^["']|["']$/g, "");
    if (cleaned.includes("/") || cleaned.startsWith(".")) {
      if (isRestrictedPath(cleaned)) {
        return { level: "restricted", reason: `Command touches protected path: ${cleaned}` };
      }
    } else if (isRestrictedPath(cleaned)) {
      return { level: "restricted", reason: `Command touches protected path: ${cleaned}` };
    }
  }
  const lower = cmd.toLowerCase();
  for (const prefix of SAFE_COMMAND_PREFIXES) {
    if (lower === prefix || lower.startsWith(prefix + " ") || lower.startsWith(prefix + "\t")) {
      // Still gate a safe prefix that chains or redirects into something else.
      if (/[;&|>`]|`|\$\(/.test(cmd.slice(prefix.length))) break;
      return { level: "safe", reason: `Known safe command: ${prefix}` };
    }
  }
  for (const rule of APPROVAL_COMMANDS) {
    if (rule.pattern.test(cmd)) return { level: rule.level, reason: rule.reason };
  }
  return { level: "approval", reason: "Unrecognized command — confirming before execution" };
}
