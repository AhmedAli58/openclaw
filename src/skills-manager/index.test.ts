import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installManagedSkill,
  listManagedSkills,
  removeManagedSkill,
  searchRegistrySkills,
  updateManagedSkill,
} from "./index.js";

const REPO_URL = "https://api.github.com/repos/openclaw/skills";
const TREE_URL = "https://api.github.com/repos/openclaw/skills/git/trees/main?recursive=1";

function rawUrl(repoPath: string): string {
  return `https://raw.githubusercontent.com/openclaw/skills/main/${repoPath}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function bytesResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/octet-stream" },
  });
}

type FetchRouteMap = Record<string, () => Response>;

function createFetchMock(routes: FetchRouteMap): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const route = routes[url];
    if (!route) {
      return new Response("not found", { status: 404 });
    }
    return route();
  }) as unknown as typeof fetch;
}

function createRegistryTree(params: {
  version: string;
  manifestName?: string;
  specVersion?: string;
  includeSkillJson?: boolean;
}) {
  const manifestName = params.manifestName ?? "self-improving-agent";
  const specVersion = params.specVersion ?? "1.0";
  const includeSkillJson = params.includeSkillJson ?? true;
  const readmePath = "skills/openclaw/self-improving-agent/README.md";
  const scriptPath = "skills/openclaw/self-improving-agent/scripts/runner.sh";
  const skillJsonPath = "skills/openclaw/self-improving-agent/skill.json";
  const tree = [
    {
      path: readmePath,
      type: "blob",
      sha: `sha-readme-${params.version}`,
    },
    {
      path: scriptPath,
      type: "blob",
      sha: `sha-script-${params.version}`,
    },
  ];
  if (includeSkillJson) {
    tree.push({
      path: skillJsonPath,
      type: "blob",
      sha: `sha-manifest-${params.version}`,
    });
  }

  const readme = `---
name: self-improving-agent
description: Track learnings and recurring errors.
---

# Self Improving Agent
`;
  const manifest = JSON.stringify(
    {
      name: manifestName,
      description: "Track learnings and recurring errors.",
      version: params.version,
      specVersion,
    },
    null,
    2,
  );

  return {
    tree,
    files: {
      [readmePath]: readme,
      [scriptPath]: "#!/bin/sh\necho skill\n",
      ...(includeSkillJson ? { [skillJsonPath]: manifest } : {}),
    },
  };
}

function createRegistryFetchMock(params: {
  version: string;
  manifestName?: string;
  specVersion?: string;
  includeSkillJson?: boolean;
}): typeof fetch {
  const registry = createRegistryTree(params);
  const routes: FetchRouteMap = {
    [REPO_URL]: () => jsonResponse({ default_branch: "main" }),
    [TREE_URL]: () => jsonResponse({ tree: registry.tree }),
  };
  for (const [repoPath, content] of Object.entries(registry.files)) {
    routes[rawUrl(repoPath)] = () =>
      repoPath.endsWith(".sh") ? bytesResponse(content) : textResponse(content);
  }
  return createFetchMock(routes);
}

async function createTempStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-manager-"));
}

afterEach(async () => {
  vi.restoreAllMocks();
});

describe("skills manager", () => {
  it("installs a skill into managed skills", async () => {
    const stateDir = await createTempStateDir();
    try {
      const fetchFn = createRegistryFetchMock({ version: "1.0.0" });
      const result = await installManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn,
      });

      expect(result.name).toBe("self-improving-agent");
      expect(result.version).toBe("1.0.0");
      await expect(
        fs.readFile(path.join(stateDir, "skills", "self-improving-agent", "README.md"), "utf-8"),
      ).resolves.toContain("Self Improving Agent");
      await expect(
        fs.readFile(path.join(stateDir, "skills", "self-improving-agent", "SKILL.md"), "utf-8"),
      ).resolves.toContain("Self Improving Agent");
      await expect(
        fs.readFile(path.join(stateDir, "skills", "self-improving-agent", "skill.json"), "utf-8"),
      ).resolves.toContain('"version": "1.0.0"');
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("is idempotent on reinstall without --force", async () => {
    const stateDir = await createTempStateDir();
    try {
      const fetchFn = createRegistryFetchMock({ version: "1.0.0" });
      await installManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn,
      });

      await expect(
        installManagedSkill({
          stateDir,
          name: "self-improving-agent",
          fetchFn,
        }),
      ).rejects.toThrow(/already installed/i);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("creates learnings templates with --init and does not overwrite existing files", async () => {
    const stateDir = await createTempStateDir();
    try {
      const fetchFn = createRegistryFetchMock({ version: "1.0.0" });
      await installManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn,
        init: true,
      });

      const learningsDir = path.join(stateDir, "workspace", ".learnings");
      const learningsFile = path.join(learningsDir, "LEARNINGS.md");
      await expect(fs.readFile(learningsFile, "utf-8")).resolves.toContain("# Learnings");

      await fs.writeFile(learningsFile, "custom content\n", "utf-8");
      await installManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn,
        init: true,
        force: true,
      });

      await expect(fs.readFile(learningsFile, "utf-8")).resolves.toBe("custom content\n");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid skills when manifest spec version is unsupported", async () => {
    const stateDir = await createTempStateDir();
    try {
      const fetchFn = createRegistryFetchMock({
        version: "1.0.0",
        specVersion: "2.0",
      });
      await expect(
        installManagedSkill({
          stateDir,
          name: "self-improving-agent",
          fetchFn,
        }),
      ).rejects.toThrow(/unsupported spec version/i);

      await expect(
        fs.access(path.join(stateDir, "skills", "self-improving-agent")),
      ).rejects.toThrow();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("falls back to cached registry data when the network fails", async () => {
    const stateDir = await createTempStateDir();
    try {
      const onlineFetch = createRegistryFetchMock({ version: "1.0.0" });
      const seeded = await searchRegistrySkills("self", {
        stateDir,
        fetchFn: onlineFetch,
      });
      expect(seeded.skills.length).toBe(1);

      const offlineFetch = vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;

      const fallback = await searchRegistrySkills("self", {
        stateDir,
        fetchFn: offlineFetch,
        forceRefresh: true,
      });

      expect(fallback.skills.length).toBe(1);
      expect(fallback.warning).toContain("Using cached registry data");
      expect(fallback.stale).toBe(true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("lists local installs when registry fetch fails and no cache exists", async () => {
    const stateDir = await createTempStateDir();
    try {
      const fetchFn = createRegistryFetchMock({ version: "1.0.0" });
      await installManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn,
      });

      await fs.rm(path.join(stateDir, "cache", "skills.json"), { force: true });

      const offlineFetch = vi.fn(async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;

      const listed = await listManagedSkills({
        stateDir,
        fetchFn: offlineFetch,
        forceRefresh: true,
      });

      expect(listed.skills).toHaveLength(1);
      expect(listed.skills[0]?.name).toBe("self-improving-agent");
      expect(listed.skills[0]?.updateAvailable).toBe(false);
      expect(listed.warning).toContain("Showing local installs only");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("detects updates, updates safely, and preserves user-generated files", async () => {
    const stateDir = await createTempStateDir();
    try {
      const fetchV1 = createRegistryFetchMock({ version: "1.0.0" });
      await installManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn: fetchV1,
      });

      const skillDir = path.join(stateDir, "skills", "self-improving-agent");
      const userFile = path.join(skillDir, "USER_NOTES.md");
      await fs.writeFile(userFile, "local notes\n", "utf-8");

      const fetchV2 = createRegistryFetchMock({ version: "1.1.0" });
      const before = await listManagedSkills({
        stateDir,
        fetchFn: fetchV2,
        forceRefresh: true,
      });
      expect(before.skills[0]?.updateAvailable).toBe(true);

      const updated = await updateManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn: fetchV2,
      });

      expect(updated.updated).toBe(true);
      expect(updated.version).toBe("1.1.0");
      expect(updated.preservedFiles).toBeGreaterThanOrEqual(1);
      await expect(fs.readFile(userFile, "utf-8")).resolves.toBe("local notes\n");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("removes only the skill directory and preserves workspace content", async () => {
    const stateDir = await createTempStateDir();
    try {
      const fetchFn = createRegistryFetchMock({ version: "1.0.0" });
      await installManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn,
      });

      const workspaceFile = path.join(stateDir, "workspace", "KEEP.md");
      await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
      await fs.writeFile(workspaceFile, "keep me\n", "utf-8");

      const removed = await removeManagedSkill({
        stateDir,
        name: "self-improving-agent",
      });

      expect(removed.removed).toBe(true);
      await expect(
        fs.access(path.join(stateDir, "skills", "self-improving-agent")),
      ).rejects.toThrow();
      await expect(fs.readFile(workspaceFile, "utf-8")).resolves.toBe("keep me\n");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("supports clean-state install with --init end-to-end", async () => {
    const stateDir = await createTempStateDir();
    try {
      const fetchFn = createRegistryFetchMock({ version: "1.0.0", includeSkillJson: false });
      const result = await installManagedSkill({
        stateDir,
        name: "self-improving-agent",
        fetchFn,
        init: true,
      });

      expect(result.path).toContain(path.join("skills", "self-improving-agent"));
      await expect(
        fs.readFile(path.join(stateDir, "skills", "self-improving-agent", "skill.json"), "utf-8"),
      ).resolves.toContain('"specVersion": "1.0"');
      await expect(
        fs.readFile(path.join(stateDir, "workspace", ".learnings", "LEARNINGS.md"), "utf-8"),
      ).resolves.toContain("# Learnings");
      await expect(
        fs.readFile(path.join(stateDir, "workspace", ".learnings", "ERRORS.md"), "utf-8"),
      ).resolves.toContain("# Error Log");
      await expect(
        fs.readFile(path.join(stateDir, "workspace", ".learnings", "FEATURE_REQUESTS.md"), "utf-8"),
      ).resolves.toContain("# Feature Requests");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
