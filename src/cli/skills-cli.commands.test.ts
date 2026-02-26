import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.fn();
const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const formatSkillsListMock = vi.fn();
const formatSkillInfoMock = vi.fn();
const formatSkillsCheckMock = vi.fn();
const searchRegistrySkillsMock = vi.fn();
const installManagedSkillMock = vi.fn();
const listManagedSkillsMock = vi.fn();
const updateManagedSkillMock = vi.fn();
const removeManagedSkillMock = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: buildWorkspaceSkillStatusMock,
}));

vi.mock("./skills-cli.format.js", () => ({
  formatSkillsList: formatSkillsListMock,
  formatSkillInfo: formatSkillInfoMock,
  formatSkillsCheck: formatSkillsCheckMock,
}));

vi.mock("../skills-manager/index.js", () => ({
  searchRegistrySkills: searchRegistrySkillsMock,
  installManagedSkill: installManagedSkillMock,
  listManagedSkills: listManagedSkillsMock,
  updateManagedSkill: updateManagedSkillMock,
  removeManagedSkill: removeManagedSkillMock,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerSkillsCli: typeof import("./skills-cli.js").registerSkillsCli;

beforeAll(async () => {
  ({ registerSkillsCli } = await import("./skills-cli.js"));
});

describe("registerSkillsCli", () => {
  const report = {
    workspaceDir: "/tmp/workspace",
    managedSkillsDir: "/tmp/workspace/.skills",
    skills: [],
  };

  async function runCli(args: string[]) {
    const program = new Command();
    registerSkillsCli(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue({ gateway: {} });
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue(report);
    formatSkillsListMock.mockReturnValue("skills-list-output");
    formatSkillInfoMock.mockReturnValue("skills-info-output");
    formatSkillsCheckMock.mockReturnValue("skills-check-output");
    searchRegistrySkillsMock.mockResolvedValue({
      source: "remote",
      stale: false,
      query: "search",
      skills: [],
    });
    installManagedSkillMock.mockResolvedValue({
      name: "self-improving-agent",
      version: "1.2.3",
      path: "/tmp/state/skills/self-improving-agent",
      initializedWorkspace: true,
      createdWorkspaceFiles: ["LEARNINGS.md"],
    });
    listManagedSkillsMock.mockResolvedValue({
      source: "remote",
      stale: false,
      skills: [],
    });
    updateManagedSkillMock.mockResolvedValue({
      name: "self-improving-agent",
      path: "/tmp/state/skills/self-improving-agent",
      updated: true,
      previousVersion: "1.2.2",
      version: "1.2.3",
      preservedFiles: 1,
    });
    removeManagedSkillMock.mockResolvedValue({
      name: "self-improving-agent",
      path: "/tmp/state/skills/self-improving-agent",
      removed: true,
    });
  });

  it("runs managed list command", async () => {
    listManagedSkillsMock.mockResolvedValueOnce({
      source: "remote",
      stale: false,
      skills: [
        {
          name: "self-improving-agent",
          version: "1.2.3",
          path: "/tmp/state/skills/self-improving-agent",
          updateAvailable: false,
        },
      ],
    });

    await runCli(["skills", "list", "--json"]);

    expect(listManagedSkillsMock).toHaveBeenCalled();
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as {
      skills: Array<{ name: string }>;
    };
    expect(payload.skills[0]?.name).toBe("self-improving-agent");
  });

  it("runs status command with resolved report and formatter options", async () => {
    await runCli(["skills", "status", "--eligible", "--verbose", "--json"]);

    expect(buildWorkspaceSkillStatusMock).toHaveBeenCalledWith("/tmp/workspace", {
      config: { gateway: {} },
    });
    expect(formatSkillsListMock).toHaveBeenCalledWith(
      report,
      expect.objectContaining({
        eligible: true,
        verbose: true,
        json: true,
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-list-output");
  });

  it("runs info command and forwards skill name", async () => {
    await runCli(["skills", "info", "peekaboo", "--json"]);

    expect(formatSkillInfoMock).toHaveBeenCalledWith(
      report,
      "peekaboo",
      expect.objectContaining({ json: true }),
    );
    expect(runtime.log).toHaveBeenCalledWith("skills-info-output");
  });

  it("runs check command and writes formatter output", async () => {
    await runCli(["skills", "check"]);

    expect(formatSkillsCheckMock).toHaveBeenCalledWith(report, expect.any(Object));
    expect(runtime.log).toHaveBeenCalledWith("skills-check-output");
  });

  it("uses managed list for default skills action", async () => {
    await runCli(["skills"]);

    expect(listManagedSkillsMock).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("No managed skills installed.");
  });

  it("runs search command and forwards query", async () => {
    await runCli(["skills", "search", "self", "improving", "--json"]);

    expect(searchRegistrySkillsMock).toHaveBeenCalledWith("self improving");
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as { query: string };
    expect(payload.query).toBe("self improving");
  });

  it("runs install command and forwards options", async () => {
    await runCli(["skills", "install", "self-improving-agent", "--init", "--force", "--json"]);

    expect(installManagedSkillMock).toHaveBeenCalledWith({
      name: "self-improving-agent",
      init: true,
      force: true,
    });
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as { name: string };
    expect(payload.name).toBe("self-improving-agent");
  });

  it("runs update command and forwards name", async () => {
    await runCli(["skills", "update", "self-improving-agent", "--json"]);

    expect(updateManagedSkillMock).toHaveBeenCalledWith({ name: "self-improving-agent" });
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as { updated: boolean };
    expect(payload.updated).toBe(true);
  });

  it("runs remove command and forwards name", async () => {
    await runCli(["skills", "remove", "self-improving-agent", "--json"]);

    expect(removeManagedSkillMock).toHaveBeenCalledWith({ name: "self-improving-agent" });
    const payload = JSON.parse(String(runtime.log.mock.calls[0]?.[0])) as { removed: boolean };
    expect(payload.removed).toBe(true);
  });

  it("reports runtime errors when report loading fails", async () => {
    loadConfigMock.mockImplementationOnce(() => {
      throw new Error("config exploded");
    });

    await runCli(["skills", "status"]);

    expect(runtime.error).toHaveBeenCalledWith("Error: config exploded");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(buildWorkspaceSkillStatusMock).not.toHaveBeenCalled();
  });

  it("reports runtime errors when managed list fails", async () => {
    listManagedSkillsMock.mockRejectedValueOnce(new Error("boom"));

    await runCli(["skills", "list"]);

    expect(runtime.error).toHaveBeenCalledWith("boom");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
