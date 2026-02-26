import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveAgentWorkspaceDirMock = vi.fn();
const resolveDefaultAgentIdMock = vi.fn();
const buildWorkspaceSkillStatusMock = vi.fn();
const loadOpenClawPluginsMock = vi.fn();
const noteMock = vi.fn();

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: resolveAgentWorkspaceDirMock,
  resolveDefaultAgentId: resolveDefaultAgentIdMock,
}));

vi.mock("../agents/skills-status.js", () => ({
  buildWorkspaceSkillStatus: buildWorkspaceSkillStatusMock,
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: loadOpenClawPluginsMock,
}));

vi.mock("../terminal/note.js", () => ({
  note: noteMock,
}));

const { noteWorkspaceStatus } = await import("./doctor-workspace-status.js");

describe("noteWorkspaceStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveDefaultAgentIdMock.mockReturnValue("main");
    resolveAgentWorkspaceDirMock.mockReturnValue("/tmp/workspace");
    buildWorkspaceSkillStatusMock.mockReturnValue({
      skills: [
        {
          name: "github",
          eligible: true,
          disabled: false,
          blockedByAllowlist: false,
        },
      ],
    });
    loadOpenClawPluginsMock.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
  });

  it("notes missing high-value skills and install hint", () => {
    noteWorkspaceStatus({} as never);

    const recommendation = noteMock.mock.calls.find(
      (call) => call[1] === "Recommended skills",
    )?.[0];
    expect(String(recommendation)).toContain("self-improving-agent");
    expect(String(recommendation)).toContain("summarize");
    expect(String(recommendation)).toContain("openclaw skills install self-improving-agent --init");
  });

  it("skips recommendation note when high-value skills are present", () => {
    buildWorkspaceSkillStatusMock.mockReturnValue({
      skills: [
        {
          name: "self-improving-agent",
          eligible: true,
          disabled: false,
          blockedByAllowlist: false,
        },
        { name: "github", eligible: true, disabled: false, blockedByAllowlist: false },
        { name: "summarize", eligible: true, disabled: false, blockedByAllowlist: false },
      ],
    });

    noteWorkspaceStatus({} as never);

    const recommendation = noteMock.mock.calls.find((call) => call[1] === "Recommended skills");
    expect(recommendation).toBeUndefined();
  });
});
