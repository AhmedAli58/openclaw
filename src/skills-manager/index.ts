import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { parseSemver } from "../infra/runtime-guard.js";
import { parseFrontmatterBlock } from "../markdown/frontmatter.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

const SKILLS_REPO_OWNER = "openclaw";
const SKILLS_REPO_NAME = "skills";
const SKILLS_REPO_SLUG = `${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}`;
const SKILLS_REPO_API_BASE = `https://api.github.com/repos/${SKILLS_REPO_SLUG}`;
const SKILLS_REPO_RAW_BASE = `https://raw.githubusercontent.com/${SKILLS_REPO_SLUG}`;
const CACHE_FILENAME = "skills.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 20_000;
const INSTALL_META_FILENAME = ".openclaw-skill-install.json";
const SUPPORTED_SPEC_MAJOR = 1;
const MAX_METADATA_CONCURRENCY = 6;
const MAX_DOWNLOAD_CONCURRENCY = 8;

const DEFAULT_FETCH_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "openclaw-skills-manager",
};

const LEARNINGS_DIR_NAME = ".learnings";

const LEARNINGS_TEMPLATES = {
  "LEARNINGS.md": "# Learnings\n## Promoted Knowledge\n",
  "ERRORS.md": "# Error Log\n## Recurring Issues\n",
  "FEATURE_REQUESTS.md": "# Feature Requests\n",
} as const;

export const HIGH_VALUE_SKILLS = ["self-improving-agent", "github", "summarize"] as const;

type GitHubRepoResponse = {
  default_branch?: string;
};

type GitHubTreeEntry = {
  path?: string;
  type?: string;
  sha?: string;
};

type GitHubTreeResponse = {
  tree?: GitHubTreeEntry[];
};

export type RemoteSkillFile = {
  repoPath: string;
  relativePath: string;
  sha: string;
};

export type RemoteSkillEntry = {
  name: string;
  author: string;
  description: string;
  version: string;
  specVersion?: string;
  readmePath: string;
  skillJsonPath?: string;
  skillMarkdownPath?: string;
  files: RemoteSkillFile[];
};

export type SkillsRegistryIndex = {
  repo: string;
  branch: string;
  fetchedAt: string;
  skills: RemoteSkillEntry[];
};

type SkillsRegistryCache = {
  schemaVersion: number;
  repo: string;
  branch: string;
  fetchedAt: string;
  skills: RemoteSkillEntry[];
};

export type RegistryIndexLoadResult = {
  index: SkillsRegistryIndex;
  source: "remote" | "cache";
  stale: boolean;
  warning?: string;
};

export type SkillsManagerNetworkOptions = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

type RegistryLoadOptions = SkillsManagerNetworkOptions & {
  stateDir?: string;
  forceRefresh?: boolean;
  allowStaleOnError?: boolean;
  now?: () => number;
};

export type SearchRegistrySkillsResult = {
  source: "remote" | "cache";
  stale: boolean;
  warning?: string;
  query: string;
  skills: RemoteSkillEntry[];
};

export type InstalledSkillRecord = {
  name: string;
  version: string;
  path: string;
  updateAvailable: boolean;
  remoteVersion?: string;
  author?: string;
};

export type ListManagedSkillsResult = {
  source?: "remote" | "cache";
  stale?: boolean;
  warning?: string;
  skills: InstalledSkillRecord[];
};

export type InstallManagedSkillParams = SkillsManagerNetworkOptions & {
  name: string;
  stateDir?: string;
  force?: boolean;
  init?: boolean;
};

export type InstallManagedSkillResult = {
  name: string;
  version: string;
  path: string;
  initializedWorkspace: boolean;
  createdWorkspaceFiles: string[];
};

export type UpdateManagedSkillParams = SkillsManagerNetworkOptions & {
  name: string;
  stateDir?: string;
};

export type UpdateManagedSkillResult = {
  name: string;
  path: string;
  updated: boolean;
  previousVersion?: string;
  version: string;
  preservedFiles: number;
};

export type RemoveManagedSkillResult = {
  name: string;
  path: string;
  removed: boolean;
};

export type InitializeLearningsResult = {
  workspaceDir: string;
  learningsDir: string;
  createdFiles: string[];
};

type StagedSkill = {
  stageRoot: string;
  stageSkillDir: string;
  entry: RemoteSkillEntry;
};

type SkillValidationResult = {
  name: string;
  version: string;
  specVersion: string;
  readmePath: string;
  skillJsonPath: string;
};

type InstallMetadata = {
  managerVersion: number;
  name: string;
  author: string;
  version: string;
  specVersion?: string;
  branch: string;
  installedAt: string;
  files: string[];
};

type SkillDirectorySummary = {
  dirName: string;
  dirPath: string;
  name: string;
  version: string;
};

type SkillTreeGroup = {
  author: string;
  skillName: string;
  rootPath: string;
  readmePath?: string;
  skillJsonPath?: string;
  skillMarkdownPath?: string;
  files: RemoteSkillFile[];
};

function resolveManagerPaths(stateDir?: string): {
  stateDir: string;
  cacheFile: string;
  managedSkillsDir: string;
  workspaceDir: string;
} {
  const resolvedStateDir = stateDir ? path.resolve(stateDir) : resolveStateDir();
  return {
    stateDir: resolvedStateDir,
    cacheFile: path.join(resolvedStateDir, "cache", CACHE_FILENAME),
    managedSkillsDir: path.join(resolvedStateDir, "skills"),
    workspaceDir: path.join(resolvedStateDir, "workspace"),
  };
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function assertManagedSkillName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Skill name is required.");
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error(`Invalid skill name: ${name}`);
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return trimmed;
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function encodeRepoPath(repoPath: string): string {
  return repoPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toRawContentUrl(branch: string, repoPath: string): string {
  return `${SKILLS_REPO_RAW_BASE}/${encodeURIComponent(branch)}/${encodeRepoPath(repoPath)}`;
}

function coerceNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSpecVersion(manifest: Record<string, unknown>): string | undefined {
  const direct =
    coerceNonEmptyString(manifest.specVersion) ?? coerceNonEmptyString(manifest.spec_version);
  if (direct) {
    return direct;
  }
  const spec = manifest.spec;
  if (spec && typeof spec === "object" && !Array.isArray(spec)) {
    return coerceNonEmptyString((spec as Record<string, unknown>).version);
  }
  return undefined;
}

function isSupportedSpecVersion(specVersion: string): boolean {
  const major = Number.parseInt(specVersion.split(".")[0] ?? "", 10);
  return Number.isFinite(major) && major === SUPPORTED_SPEC_MAJOR;
}

function compareVersions(remote: string, local: string): number {
  const remoteSemver = parseSemver(remote);
  const localSemver = parseSemver(local);
  if (remoteSemver && localSemver) {
    if (remoteSemver.major !== localSemver.major) {
      return remoteSemver.major > localSemver.major ? 1 : -1;
    }
    if (remoteSemver.minor !== localSemver.minor) {
      return remoteSemver.minor > localSemver.minor ? 1 : -1;
    }
    if (remoteSemver.patch !== localSemver.patch) {
      return remoteSemver.patch > localSemver.patch ? 1 : -1;
    }
    return 0;
  }
  if (remote === local) {
    return 0;
  }
  return remote > local ? 1 : -1;
}

function isRemoteVersionNewer(remote: string, local: string): boolean {
  return compareVersions(remote, local) > 0;
}

function sanitizeRelativeSkillPath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.trim());
  if (!normalized || normalized === "." || normalized === "..") {
    throw new Error(`Invalid skill file path: "${relativePath}"`);
  }
  if (normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`Invalid skill file path: "${relativePath}"`);
  }
  if (path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid skill file path: "${relativePath}"`);
  }
  return normalized;
}

function normalizeSkillVersionHash(files: RemoteSkillFile[]): string {
  const digest = crypto.createHash("sha256");
  for (const file of files.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    digest.update(file.relativePath);
    digest.update(":");
    digest.update(file.sha);
    digest.update("\n");
  }
  return digest.digest("hex").slice(0, 12);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function fetchResponse(params: {
  url: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
  headers?: HeadersInit;
}): Promise<Response> {
  const headers = new Headers(DEFAULT_FETCH_HEADERS);
  if (params.headers) {
    const incomingHeaders = new Headers(params.headers);
    for (const [key, value] of incomingHeaders.entries()) {
      headers.set(key, value);
    }
  }

  return await fetchWithTimeout(
    params.url,
    {
      headers,
    },
    params.timeoutMs,
    params.fetchFn,
  );
}

async function fetchJsonOrThrow<T>(params: {
  url: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
}): Promise<T> {
  const response = await fetchResponse(params);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${params.url}`);
  }
  return (await response.json()) as T;
}

async function fetchBytesOrThrow(params: {
  url: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
}): Promise<Uint8Array> {
  const response = await fetchResponse(params);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${params.url}`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

async function maybeFetchText(params: {
  url: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
}): Promise<string | undefined> {
  const response = await fetchResponse(params);
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${params.url}`);
  }
  return await response.text();
}

async function mapWithConcurrency<T, TResult>(
  input: T[],
  concurrency: number,
  mapper: (item: T) => Promise<TResult>,
): Promise<TResult[]> {
  if (input.length === 0) {
    return [];
  }

  const workers = Math.max(1, Math.min(concurrency, input.length));
  const result: TResult[] = [];
  result.length = input.length;
  let index = 0;

  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (index < input.length) {
        const current = index;
        index += 1;
        const item = input[current];
        if (item === undefined) {
          continue;
        }
        result[current] = await mapper(item);
      }
    }),
  );

  return result;
}

function collectSkillTreeGroups(tree: GitHubTreeEntry[]): SkillTreeGroup[] {
  const groups = new Map<string, SkillTreeGroup>();
  for (const entry of tree) {
    if (entry.type !== "blob") {
      continue;
    }
    const fullPath = coerceNonEmptyString(entry.path);
    const sha = coerceNonEmptyString(entry.sha);
    if (!fullPath || !sha) {
      continue;
    }
    const match = /^skills\/([^/]+)\/([^/]+)\/(.+)$/.exec(fullPath);
    if (!match) {
      continue;
    }
    const author = match[1];
    const skillName = match[2];
    const relativePath = match[3];
    const rootPath = `skills/${author}/${skillName}`;
    const fileName = path.posix.basename(relativePath).toLowerCase();

    const existing = groups.get(rootPath);
    const group: SkillTreeGroup =
      existing ??
      ({
        author,
        skillName,
        rootPath,
        files: [],
      } satisfies SkillTreeGroup);

    group.files.push({
      repoPath: fullPath,
      relativePath,
      sha,
    });

    if (fileName === "readme.md") {
      group.readmePath = fullPath;
    } else if (fileName === "skill.json") {
      group.skillJsonPath = fullPath;
    } else if (fileName === "skill.md" || fileName === "skill.mdx" || fileName === "skill.mdx.md") {
      group.skillMarkdownPath = fullPath;
    }

    groups.set(rootPath, group);
  }

  return [...groups.values()].toSorted((a, b) =>
    `${a.author}/${a.skillName}`.localeCompare(`${b.author}/${b.skillName}`),
  );
}

function findSkillFilePath(group: SkillTreeGroup, fileName: string): string | undefined {
  const wanted = fileName.toLowerCase();
  const match = group.files.find(
    (file) => path.posix.basename(file.relativePath).toLowerCase() === wanted,
  );
  return match?.repoPath;
}

async function buildRemoteSkillEntry(params: {
  branch: string;
  group: SkillTreeGroup;
  fetchFn: typeof fetch;
  timeoutMs: number;
}): Promise<RemoteSkillEntry | null> {
  const readmeRepoPath = params.group.readmePath ?? findSkillFilePath(params.group, "README.md");
  if (!readmeRepoPath) {
    return null;
  }

  const readmeUrl = toRawContentUrl(params.branch, readmeRepoPath);
  const readmeText = await maybeFetchText({
    url: readmeUrl,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
  });
  if (!readmeText) {
    return null;
  }

  const frontmatter = parseFrontmatterBlock(readmeText);
  let manifestObject: Record<string, unknown> | undefined;
  const skillJsonPath = params.group.skillJsonPath ?? findSkillFilePath(params.group, "skill.json");
  if (skillJsonPath) {
    const manifestRaw = await maybeFetchText({
      url: toRawContentUrl(params.branch, skillJsonPath),
      fetchFn: params.fetchFn,
      timeoutMs: params.timeoutMs,
    });
    if (manifestRaw) {
      try {
        const parsed = JSON.parse(manifestRaw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          manifestObject = parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore malformed manifests in index metadata; validation runs on install.
      }
    }
  }

  const manifestName = manifestObject ? coerceNonEmptyString(manifestObject.name) : undefined;
  const manifestDescription = manifestObject
    ? coerceNonEmptyString(manifestObject.description)
    : undefined;
  const manifestVersion = manifestObject ? coerceNonEmptyString(manifestObject.version) : undefined;
  const specVersion = manifestObject ? parseSpecVersion(manifestObject) : undefined;

  const frontmatterName = coerceNonEmptyString(frontmatter.name);
  const frontmatterDescription = coerceNonEmptyString(frontmatter.description);
  const frontmatterVersion = coerceNonEmptyString(frontmatter.version);
  const resolvedName = manifestName ?? frontmatterName ?? params.group.skillName;
  const description = manifestDescription ?? frontmatterDescription ?? "";
  const version =
    manifestVersion ?? frontmatterVersion ?? normalizeSkillVersionHash(params.group.files);

  const skillMarkdownPath =
    params.group.skillMarkdownPath ??
    findSkillFilePath(params.group, "skill.md") ??
    findSkillFilePath(params.group, "SKILL.md");

  return {
    name: resolvedName,
    author: params.group.author,
    description,
    version,
    specVersion,
    readmePath: readmeRepoPath,
    skillJsonPath: skillJsonPath ?? undefined,
    skillMarkdownPath: skillMarkdownPath ?? undefined,
    files: params.group.files.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

async function fetchRemoteRegistryIndex(params: {
  fetchFn: typeof fetch;
  timeoutMs: number;
  now: () => number;
}): Promise<SkillsRegistryIndex> {
  const repoInfo = await fetchJsonOrThrow<GitHubRepoResponse>({
    url: SKILLS_REPO_API_BASE,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
  });
  const branch = coerceNonEmptyString(repoInfo.default_branch) ?? "main";
  const tree = await fetchJsonOrThrow<GitHubTreeResponse>({
    url: `${SKILLS_REPO_API_BASE}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
  });

  const groups = collectSkillTreeGroups(tree.tree ?? []);
  const entries = await mapWithConcurrency(
    groups,
    MAX_METADATA_CONCURRENCY,
    async (group) =>
      await buildRemoteSkillEntry({
        branch,
        group,
        fetchFn: params.fetchFn,
        timeoutMs: params.timeoutMs,
      }),
  );

  return {
    repo: SKILLS_REPO_SLUG,
    branch,
    fetchedAt: new Date(params.now()).toISOString(),
    skills: entries.filter((entry): entry is RemoteSkillEntry => Boolean(entry)),
  };
}

function toCacheShape(index: SkillsRegistryIndex): SkillsRegistryCache {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    repo: index.repo,
    branch: index.branch,
    fetchedAt: index.fetchedAt,
    skills: index.skills,
  };
}

function fromCacheShape(cache: SkillsRegistryCache): SkillsRegistryIndex {
  return {
    repo: cache.repo,
    branch: cache.branch,
    fetchedAt: cache.fetchedAt,
    skills: cache.skills,
  };
}

function isCacheFresh(cache: SkillsRegistryCache, nowMs: number): boolean {
  const fetchedMs = Date.parse(cache.fetchedAt);
  if (!Number.isFinite(fetchedMs)) {
    return false;
  }
  return nowMs - fetchedMs <= CACHE_TTL_MS;
}

async function readRegistryCache(cacheFile: string): Promise<SkillsRegistryCache | undefined> {
  try {
    const parsed = await readJsonFile<unknown>(cacheFile);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const rec = parsed as Partial<SkillsRegistryCache>;
    if (rec.schemaVersion !== CACHE_SCHEMA_VERSION) {
      return undefined;
    }
    if (typeof rec.repo !== "string" || typeof rec.branch !== "string") {
      return undefined;
    }
    if (typeof rec.fetchedAt !== "string" || !Array.isArray(rec.skills)) {
      return undefined;
    }
    return rec as SkillsRegistryCache;
  } catch {
    return undefined;
  }
}

async function writeRegistryCache(cacheFile: string, index: SkillsRegistryIndex): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await writeJsonFile(cacheFile, toCacheShape(index));
}

async function loadRegistryIndex(
  options: RegistryLoadOptions = {},
): Promise<RegistryIndexLoadResult> {
  const paths = resolveManagerPaths(options.stateDir);
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const now = options.now ?? (() => Date.now());
  const allowStaleOnError = options.allowStaleOnError !== false;
  const cache = await readRegistryCache(paths.cacheFile);
  const nowMs = now();

  if (!options.forceRefresh && cache && isCacheFresh(cache, nowMs)) {
    return {
      index: fromCacheShape(cache),
      source: "cache",
      stale: false,
    };
  }

  try {
    const remote = await fetchRemoteRegistryIndex({
      fetchFn,
      timeoutMs,
      now,
    });
    await writeRegistryCache(paths.cacheFile, remote);
    return {
      index: remote,
      source: "remote",
      stale: false,
    };
  } catch (err) {
    if (cache && allowStaleOnError) {
      return {
        index: fromCacheShape(cache),
        source: "cache",
        stale: true,
        warning: `Remote registry fetch failed (${String(err)}). Using cached registry data.`,
      };
    }
    throw err;
  }
}

export async function searchRegistrySkills(
  query: string,
  options: RegistryLoadOptions = {},
): Promise<SearchRegistrySkillsResult> {
  const normalized = query.trim().toLowerCase();
  const load = await loadRegistryIndex({
    ...options,
    allowStaleOnError: true,
  });
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const matches = load.index.skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.author} ${skill.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
  return {
    source: load.source,
    stale: load.stale,
    warning: load.warning,
    query: query.trim(),
    skills: matches.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

function findRegistrySkillByName(
  index: SkillsRegistryIndex,
  name: string,
): RemoteSkillEntry | undefined {
  const wanted = normalizeSkillName(name);
  return index.skills.find((skill) => normalizeSkillName(skill.name) === wanted);
}

async function writeBytesToFile(filePath: string, bytes: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, bytes);
}

async function stageSkillFromRegistry(params: {
  entry: RemoteSkillEntry;
  branch: string;
  managedSkillsDir: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
}): Promise<StagedSkill> {
  await fs.mkdir(params.managedSkillsDir, { recursive: true });
  const stageRoot = await fs.mkdtemp(
    path.join(params.managedSkillsDir, `.openclaw-skill-stage-${params.entry.name}-`),
  );
  const stageSkillDir = path.join(stageRoot, params.entry.name);
  await fs.mkdir(stageSkillDir, { recursive: true });

  await mapWithConcurrency(params.entry.files, MAX_DOWNLOAD_CONCURRENCY, async (file) => {
    const relative = sanitizeRelativeSkillPath(file.relativePath);
    const destination = path.resolve(stageSkillDir, ...relative.split("/"));
    if (!isPathInside(stageSkillDir, destination)) {
      throw new Error(`Skill file escapes target directory: ${file.relativePath}`);
    }
    const bytes = await fetchBytesOrThrow({
      url: toRawContentUrl(params.branch, file.repoPath),
      fetchFn: params.fetchFn,
      timeoutMs: params.timeoutMs,
    });
    await writeBytesToFile(destination, bytes);
  });

  return {
    stageRoot,
    stageSkillDir,
    entry: params.entry,
  };
}

async function findExistingFileCaseInsensitive(
  rootDir: string,
  expectedBaseName: string,
): Promise<string | undefined> {
  const wanted = expectedBaseName.toLowerCase();
  try {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (entry.name.toLowerCase() === wanted) {
        return path.join(rootDir, entry.name);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function maybeReadJsonObject(filePath: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = await readJsonFile<unknown>(filePath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function normalizeSkillLayout(params: {
  skillDir: string;
  expectedName: string;
  fallbackVersion: string;
}): Promise<void> {
  const readmePath =
    (await findExistingFileCaseInsensitive(params.skillDir, "README.md")) ??
    path.join(params.skillDir, "README.md");
  if (!(await pathExists(readmePath))) {
    throw new Error("Invalid skill: missing README.md");
  }

  const skillMdPath = path.join(params.skillDir, "SKILL.md");
  if (!(await pathExists(skillMdPath))) {
    const lowercaseSkillMd = await findExistingFileCaseInsensitive(params.skillDir, "skill.md");
    if (lowercaseSkillMd && (await pathExists(lowercaseSkillMd))) {
      await fs.copyFile(lowercaseSkillMd, skillMdPath);
    } else {
      await fs.copyFile(readmePath, skillMdPath);
    }
  }

  const skillJsonPath = path.join(params.skillDir, "skill.json");
  if (!(await pathExists(skillJsonPath))) {
    const readme = await fs.readFile(readmePath, "utf-8");
    const frontmatter = parseFrontmatterBlock(readme);
    const manifestName = coerceNonEmptyString(frontmatter.name) ?? params.expectedName;
    const manifestDescription = coerceNonEmptyString(frontmatter.description);
    const manifestVersion = coerceNonEmptyString(frontmatter.version) ?? params.fallbackVersion;
    const generatedManifest = {
      name: manifestName,
      description: manifestDescription,
      version: manifestVersion,
      specVersion: "1.0",
      entrypoint: path.basename(readmePath),
      generatedBy: "openclaw-skills-manager",
    };
    await writeJsonFile(skillJsonPath, generatedManifest);
  }
}

async function validateSkillDirectory(params: {
  skillDir: string;
  expectedName: string;
}): Promise<SkillValidationResult> {
  const readmePath = await findExistingFileCaseInsensitive(params.skillDir, "README.md");
  if (!readmePath) {
    throw new Error("Invalid skill: missing README.md");
  }

  const skillJsonPath = await findExistingFileCaseInsensitive(params.skillDir, "skill.json");
  if (!skillJsonPath) {
    throw new Error("Invalid skill: missing skill.json");
  }

  const manifest = await maybeReadJsonObject(skillJsonPath);
  if (!manifest) {
    throw new Error("Invalid skill: skill.json is not a valid JSON object");
  }

  const manifestName = coerceNonEmptyString(manifest.name);
  if (!manifestName) {
    throw new Error("Invalid skill: skill.json.name is required");
  }
  if (normalizeSkillName(manifestName) !== normalizeSkillName(params.expectedName)) {
    throw new Error(
      `Invalid skill: name mismatch (expected "${params.expectedName}", got "${manifestName}")`,
    );
  }

  const manifestVersion = coerceNonEmptyString(manifest.version);
  if (!manifestVersion) {
    throw new Error("Invalid skill: skill.json.version is required");
  }

  const specVersion = parseSpecVersion(manifest);
  if (!specVersion) {
    throw new Error("Invalid skill: skill.json specVersion is required");
  }
  if (!isSupportedSpecVersion(specVersion)) {
    throw new Error(
      `Invalid skill: unsupported spec version "${specVersion}" (supported: ${SUPPORTED_SPEC_MAJOR}.x)`,
    );
  }

  const skillMdPath = path.join(params.skillDir, "SKILL.md");
  if (!(await pathExists(skillMdPath))) {
    throw new Error("Invalid skill: missing SKILL.md");
  }

  return {
    name: manifestName,
    version: manifestVersion,
    specVersion,
    readmePath,
    skillJsonPath,
  };
}

async function collectRelativeFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(currentDir: string) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        continue;
      }
      const relative = path.relative(rootDir, absolute).split(path.sep).join("/");
      files.push(relative);
    }
  }
  await walk(rootDir);
  return files.toSorted();
}

async function writeInstallMetadata(params: {
  skillDir: string;
  name: string;
  author: string;
  version: string;
  specVersion?: string;
  branch: string;
}): Promise<void> {
  const files = await collectRelativeFiles(params.skillDir);
  const metadata: InstallMetadata = {
    managerVersion: 1,
    name: params.name,
    author: params.author,
    version: params.version,
    specVersion: params.specVersion,
    branch: params.branch,
    installedAt: new Date().toISOString(),
    files,
  };
  await writeJsonFile(path.join(params.skillDir, INSTALL_META_FILENAME), metadata);
}

async function replaceDirectoryAtomically(params: {
  stagedDir: string;
  targetDir: string;
}): Promise<void> {
  const parentDir = path.dirname(params.targetDir);
  await fs.mkdir(parentDir, { recursive: true });

  const targetExists = await pathExists(params.targetDir);
  if (!targetExists) {
    await fs.rename(params.stagedDir, params.targetDir);
    return;
  }

  const backupDir = path.join(
    parentDir,
    `${path.basename(params.targetDir)}.backup-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  );

  await fs.rename(params.targetDir, backupDir);
  try {
    await fs.rename(params.stagedDir, params.targetDir);
    await fs.rm(backupDir, { recursive: true, force: true });
  } catch (err) {
    await fs.rm(params.targetDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rename(backupDir, params.targetDir).catch(() => undefined);
    throw err;
  }
}

async function readInstalledSkillSummary(
  managedSkillsDir: string,
): Promise<SkillDirectorySummary[]> {
  if (!(await pathExists(managedSkillsDir))) {
    return [];
  }
  const entries = await fs.readdir(managedSkillsDir, { withFileTypes: true });
  const result: SkillDirectorySummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(".openclaw-skill-stage-")) {
      continue;
    }
    const dirPath = path.join(managedSkillsDir, entry.name);
    const skillJson = await findExistingFileCaseInsensitive(dirPath, "skill.json");
    const metadataPath = path.join(dirPath, INSTALL_META_FILENAME);
    let name = entry.name;
    let version = "unknown";

    if (skillJson) {
      const manifest = await maybeReadJsonObject(skillJson);
      const manifestName = manifest ? coerceNonEmptyString(manifest.name) : undefined;
      const manifestVersion = manifest ? coerceNonEmptyString(manifest.version) : undefined;
      if (manifestName) {
        name = manifestName;
      }
      if (manifestVersion) {
        version = manifestVersion;
      }
    }

    if (version === "unknown" && (await pathExists(metadataPath))) {
      const metadata = await maybeReadJsonObject(metadataPath);
      const metadataVersion = metadata ? coerceNonEmptyString(metadata.version) : undefined;
      if (metadataVersion) {
        version = metadataVersion;
      }
    }

    result.push({
      dirName: entry.name,
      dirPath,
      name,
      version,
    });
  }
  return result.toSorted((a, b) => a.name.localeCompare(b.name));
}

async function copyUserGeneratedFiles(params: {
  existingDir: string;
  stagedDir: string;
}): Promise<number> {
  const existingFiles = await collectRelativeFiles(params.existingDir);
  const stagedFiles = new Set(await collectRelativeFiles(params.stagedDir));
  let preserved = 0;

  for (const relativePath of existingFiles) {
    if (relativePath === INSTALL_META_FILENAME) {
      continue;
    }
    if (stagedFiles.has(relativePath)) {
      continue;
    }
    const source = path.join(params.existingDir, ...relativePath.split("/"));
    const destination = path.join(params.stagedDir, ...relativePath.split("/"));
    if (!isPathInside(params.stagedDir, destination)) {
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
    preserved += 1;
  }

  return preserved;
}

export async function initializeSelfImprovingWorkspace(
  params: { stateDir?: string } = {},
): Promise<InitializeLearningsResult> {
  const paths = resolveManagerPaths(params.stateDir);
  const learningsDir = path.join(paths.workspaceDir, LEARNINGS_DIR_NAME);
  await fs.mkdir(learningsDir, { recursive: true });

  const createdFiles: string[] = [];
  for (const [fileName, content] of Object.entries(LEARNINGS_TEMPLATES)) {
    const targetPath = path.join(learningsDir, fileName);
    if (await pathExists(targetPath)) {
      continue;
    }
    await fs.writeFile(targetPath, content, "utf-8");
    createdFiles.push(fileName);
  }

  return {
    workspaceDir: paths.workspaceDir,
    learningsDir,
    createdFiles,
  };
}

export async function installManagedSkill(
  params: InstallManagedSkillParams,
): Promise<InstallManagedSkillResult> {
  const skillName = assertManagedSkillName(params.name);
  const paths = resolveManagerPaths(params.stateDir);
  const targetPath = path.join(paths.managedSkillsDir, skillName);
  if (!isPathInside(paths.managedSkillsDir, targetPath)) {
    throw new Error(`Refusing to install outside managed skills directory: ${targetPath}`);
  }

  if (!params.force && (await pathExists(targetPath))) {
    throw new Error(`Skill "${skillName}" is already installed. Re-run with --force to overwrite.`);
  }

  const indexLoad = await loadRegistryIndex({
    stateDir: paths.stateDir,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
    allowStaleOnError: true,
  });
  const entry = findRegistrySkillByName(indexLoad.index, skillName);
  if (!entry) {
    throw new Error(`Skill "${skillName}" not found in registry ${SKILLS_REPO_SLUG}.`);
  }

  const staged = await stageSkillFromRegistry({
    entry,
    branch: indexLoad.index.branch,
    managedSkillsDir: paths.managedSkillsDir,
    fetchFn: params.fetchFn ?? fetch,
    timeoutMs: Math.max(1_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  let validation: SkillValidationResult | undefined;
  let createdWorkspaceFiles: string[] = [];
  let initializedWorkspace = false;
  try {
    await normalizeSkillLayout({
      skillDir: staged.stageSkillDir,
      expectedName: skillName,
      fallbackVersion: entry.version,
    });
    validation = await validateSkillDirectory({
      skillDir: staged.stageSkillDir,
      expectedName: skillName,
    });
    await writeInstallMetadata({
      skillDir: staged.stageSkillDir,
      name: validation.name,
      author: entry.author,
      version: validation.version,
      specVersion: validation.specVersion,
      branch: indexLoad.index.branch,
    });
    await replaceDirectoryAtomically({
      stagedDir: staged.stageSkillDir,
      targetDir: targetPath,
    });
  } finally {
    await fs.rm(staged.stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!validation) {
    throw new Error("Skill install failed during validation.");
  }

  if (params.init && normalizeSkillName(skillName) === "self-improving-agent") {
    const initResult = await initializeSelfImprovingWorkspace({ stateDir: paths.stateDir });
    initializedWorkspace = true;
    createdWorkspaceFiles = initResult.createdFiles;
  }

  return {
    name: validation.name,
    version: validation.version,
    path: targetPath,
    initializedWorkspace,
    createdWorkspaceFiles,
  };
}

export async function listManagedSkills(
  params: RegistryLoadOptions = {},
): Promise<ListManagedSkillsResult> {
  const paths = resolveManagerPaths(params.stateDir);
  const installed = await readInstalledSkillSummary(paths.managedSkillsDir);
  if (installed.length === 0) {
    return { skills: [] };
  }

  let indexLoad: RegistryIndexLoadResult | undefined;
  try {
    indexLoad = await loadRegistryIndex({
      ...params,
      stateDir: paths.stateDir,
      allowStaleOnError: true,
    });
  } catch (err) {
    return {
      warning: `Remote registry fetch failed (${String(err)}). Showing local installs only.`,
      skills: installed.map((local) => ({
        name: local.name,
        version: local.version,
        path: local.dirPath,
        updateAvailable: false,
      })),
    };
  }

  const remoteByName = new Map(
    indexLoad.index.skills.map((entry) => [normalizeSkillName(entry.name), entry] as const),
  );

  return {
    source: indexLoad.source,
    stale: indexLoad.stale,
    warning: indexLoad.warning,
    skills: installed.map((local) => {
      const remote = remoteByName.get(normalizeSkillName(local.name));
      const remoteVersion = remote?.version;
      const updateAvailable = remoteVersion
        ? local.version !== "unknown" && isRemoteVersionNewer(remoteVersion, local.version)
        : false;
      return {
        name: local.name,
        version: local.version,
        path: local.dirPath,
        updateAvailable,
        remoteVersion,
        author: remote?.author,
      };
    }),
  };
}

export async function updateManagedSkill(
  params: UpdateManagedSkillParams,
): Promise<UpdateManagedSkillResult> {
  const skillName = assertManagedSkillName(params.name);
  const paths = resolveManagerPaths(params.stateDir);
  const targetPath = path.join(paths.managedSkillsDir, skillName);
  if (!isPathInside(paths.managedSkillsDir, targetPath)) {
    throw new Error(`Refusing to update outside managed skills directory: ${targetPath}`);
  }
  if (!(await pathExists(targetPath))) {
    throw new Error(`Skill "${skillName}" is not installed.`);
  }

  const localSummary = (await readInstalledSkillSummary(paths.managedSkillsDir)).find(
    (skill) => normalizeSkillName(skill.name) === normalizeSkillName(skillName),
  );
  const previousVersion = localSummary?.version;

  const indexLoad = await loadRegistryIndex({
    stateDir: paths.stateDir,
    fetchFn: params.fetchFn,
    timeoutMs: params.timeoutMs,
    allowStaleOnError: true,
  });
  const remote = findRegistrySkillByName(indexLoad.index, skillName);
  if (!remote) {
    throw new Error(`Skill "${skillName}" is not present in registry ${SKILLS_REPO_SLUG}.`);
  }

  if (
    previousVersion &&
    previousVersion !== "unknown" &&
    !isRemoteVersionNewer(remote.version, previousVersion)
  ) {
    return {
      name: skillName,
      path: targetPath,
      updated: false,
      previousVersion,
      version: previousVersion,
      preservedFiles: 0,
    };
  }

  const staged = await stageSkillFromRegistry({
    entry: remote,
    branch: indexLoad.index.branch,
    managedSkillsDir: paths.managedSkillsDir,
    fetchFn: params.fetchFn ?? fetch,
    timeoutMs: Math.max(1_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  let validation: SkillValidationResult | undefined;
  let preservedFiles = 0;
  try {
    await normalizeSkillLayout({
      skillDir: staged.stageSkillDir,
      expectedName: skillName,
      fallbackVersion: remote.version,
    });
    validation = await validateSkillDirectory({
      skillDir: staged.stageSkillDir,
      expectedName: skillName,
    });
    preservedFiles = await copyUserGeneratedFiles({
      existingDir: targetPath,
      stagedDir: staged.stageSkillDir,
    });
    await writeInstallMetadata({
      skillDir: staged.stageSkillDir,
      name: validation.name,
      author: remote.author,
      version: validation.version,
      specVersion: validation.specVersion,
      branch: indexLoad.index.branch,
    });
    await replaceDirectoryAtomically({
      stagedDir: staged.stageSkillDir,
      targetDir: targetPath,
    });
  } finally {
    await fs.rm(staged.stageRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  if (!validation) {
    throw new Error("Skill update failed during validation.");
  }

  return {
    name: validation.name,
    path: targetPath,
    updated: true,
    previousVersion,
    version: validation.version,
    preservedFiles,
  };
}

export async function removeManagedSkill(params: {
  name: string;
  stateDir?: string;
}): Promise<RemoveManagedSkillResult> {
  const skillName = assertManagedSkillName(params.name);
  const paths = resolveManagerPaths(params.stateDir);
  const targetPath = path.join(paths.managedSkillsDir, skillName);
  if (!isPathInside(paths.managedSkillsDir, targetPath)) {
    throw new Error(`Refusing to remove outside managed skills directory: ${targetPath}`);
  }
  if (!(await pathExists(targetPath))) {
    return {
      name: skillName,
      path: targetPath,
      removed: false,
    };
  }
  await fs.rm(targetPath, { recursive: true, force: true });
  return {
    name: skillName,
    path: targetPath,
    removed: true,
  };
}
