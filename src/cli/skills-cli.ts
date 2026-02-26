import type { Command } from "commander";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import {
  installManagedSkill,
  listManagedSkills,
  removeManagedSkill,
  searchRegistrySkills,
  updateManagedSkill,
} from "../skills-manager/index.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

export type {
  SkillInfoOptions,
  SkillsCheckOptions,
  SkillsListOptions,
} from "./skills-cli.format.js";
export { formatSkillInfo, formatSkillsCheck, formatSkillsList } from "./skills-cli.format.js";

type SkillStatusReport = Awaited<
  ReturnType<(typeof import("../agents/skills-status.js"))["buildWorkspaceSkillStatus"]>
>;

async function loadSkillsStatusReport(): Promise<SkillStatusReport> {
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
  const { buildWorkspaceSkillStatus } = await import("../agents/skills-status.js");
  return buildWorkspaceSkillStatus(workspaceDir, { config });
}

async function runSkillsAction(render: (report: SkillStatusReport) => string): Promise<void> {
  try {
    const report = await loadSkillsStatusReport();
    defaultRuntime.log(render(report));
  } catch (err) {
    defaultRuntime.error(String(err));
    defaultRuntime.exit(1);
  }
}

function reportSkillCommandError(err: unknown): void {
  defaultRuntime.error(err instanceof Error ? err.message : String(err));
  defaultRuntime.exit(1);
}

function formatUpdateBadge(updateAvailable: boolean): string {
  return updateAvailable ? theme.warn("yes") : theme.muted("no");
}

function renderManagedSkillsList(params: {
  skills: Awaited<ReturnType<typeof listManagedSkills>>["skills"];
  warning?: string;
  json?: boolean;
}): string {
  if (params.json) {
    return JSON.stringify(
      {
        skills: params.skills,
      },
      null,
      2,
    );
  }

  if (params.skills.length === 0) {
    return "No managed skills installed.";
  }

  const rows = params.skills.map((skill) => ({
    Skill: theme.command(skill.name),
    Author: skill.author ?? "",
    Version: skill.version,
    Update: formatUpdateBadge(skill.updateAvailable),
    Path: theme.muted(shortenHomePath(skill.path)),
  }));

  const table = renderTable({
    width: Math.max(60, (process.stdout.columns ?? 120) - 1),
    columns: [
      { key: "Skill", header: "Skill", minWidth: 22, flex: true },
      { key: "Author", header: "Author", minWidth: 14 },
      { key: "Version", header: "Version", minWidth: 12 },
      { key: "Update", header: "Update", minWidth: 8 },
      { key: "Path", header: "Path", minWidth: 24, flex: true },
    ],
    rows,
  }).trimEnd();

  const lines: string[] = [theme.heading("Managed Skills"), table];
  if (params.warning) {
    lines.push("");
    lines.push(theme.warn(params.warning));
  }
  return lines.join("\n");
}

function renderSearchResults(params: {
  query: string;
  skills: Awaited<ReturnType<typeof searchRegistrySkills>>["skills"];
  warning?: string;
  json?: boolean;
}): string {
  if (params.json) {
    return JSON.stringify(
      {
        query: params.query,
        skills: params.skills,
      },
      null,
      2,
    );
  }

  if (params.skills.length === 0) {
    const lines = [`No skills matched "${params.query}".`];
    if (params.warning) {
      lines.push(theme.warn(params.warning));
    }
    return lines.join("\n");
  }

  const rows = params.skills.map((skill) => ({
    Skill: theme.command(skill.name),
    Author: skill.author,
    Version: skill.version,
    Description: theme.muted(skill.description),
  }));

  const table = renderTable({
    width: Math.max(60, (process.stdout.columns ?? 120) - 1),
    columns: [
      { key: "Skill", header: "Skill", minWidth: 20, flex: true },
      { key: "Author", header: "Author", minWidth: 16 },
      { key: "Version", header: "Version", minWidth: 12 },
      { key: "Description", header: "Description", minWidth: 24, flex: true },
    ],
    rows,
  }).trimEnd();

  const lines = [theme.heading(`Registry Search: ${params.query}`), table];
  if (params.warning) {
    lines.push("");
    lines.push(theme.warn(params.warning));
  }
  return lines.join("\n");
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("Manage installed skills and inspect skill readiness")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/skills", "docs.openclaw.ai/cli/skills")}\n`,
    );

  skills
    .command("search")
    .description("Search the remote skills registry")
    .argument("<query...>", "Search query")
    .option("--json", "Output as JSON", false)
    .action(async (queryParts: string[], opts: { json?: boolean }) => {
      const query = queryParts.join(" ").trim();
      if (!query) {
        reportSkillCommandError(
          new Error(
            `Missing search query. Example: ${formatCliCommand("openclaw skills search github")}`,
          ),
        );
      }
      try {
        const result = await searchRegistrySkills(query);
        defaultRuntime.log(
          renderSearchResults({
            query,
            skills: result.skills,
            warning: result.warning,
            json: opts.json,
          }),
        );
      } catch (err) {
        reportSkillCommandError(err);
      }
    });

  skills
    .command("install")
    .description("Install a skill from the remote registry")
    .argument("<name>", "Skill name")
    .option("--init", "Initialize self-improving-agent workspace learnings", false)
    .option("--force", "Overwrite existing install", false)
    .option("--json", "Output as JSON", false)
    .action(
      async (
        name: string,
        opts: {
          init?: boolean;
          force?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const result = await installManagedSkill({
            name,
            init: opts.init,
            force: opts.force,
          });

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
            return;
          }

          const lines = [
            `${theme.success("Installed")} ${theme.command(result.name)} ${theme.muted(`(${result.version})`)}`,
            `${theme.muted("Path:")} ${shortenHomePath(result.path)}`,
          ];
          if (result.initializedWorkspace) {
            lines.push(
              `${theme.muted("Workspace init:")} ${
                result.createdWorkspaceFiles.length > 0
                  ? result.createdWorkspaceFiles.join(", ")
                  : "already initialized"
              }`,
            );
          }
          defaultRuntime.log(lines.join("\n"));
        } catch (err) {
          reportSkillCommandError(err);
        }
      },
    );

  skills
    .command("list")
    .description("List installed managed skills")
    .option("--json", "Output as JSON", false)
    .action(async (opts: { json?: boolean }) => {
      try {
        const result = await listManagedSkills();
        defaultRuntime.log(
          renderManagedSkillsList({
            skills: result.skills,
            warning: result.warning,
            json: opts.json,
          }),
        );
      } catch (err) {
        reportSkillCommandError(err);
      }
    });

  skills
    .command("update")
    .description("Update an installed managed skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const result = await updateManagedSkill({ name });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.updated) {
          defaultRuntime.log(
            `${theme.command(result.name)} is already up to date${result.version ? ` (${result.version})` : ""}.`,
          );
          return;
        }
        defaultRuntime.log(
          [
            `${theme.success("Updated")} ${theme.command(result.name)} ${theme.muted(
              `${result.previousVersion ?? "unknown"} → ${result.version}`,
            )}`,
            `${theme.muted("Path:")} ${shortenHomePath(result.path)}`,
            `${theme.muted("Preserved files:")} ${String(result.preservedFiles)}`,
          ].join("\n"),
        );
      } catch (err) {
        reportSkillCommandError(err);
      }
    });

  skills
    .command("remove")
    .description("Remove an installed managed skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name: string, opts: { json?: boolean }) => {
      try {
        const result = await removeManagedSkill({ name });
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        if (!result.removed) {
          defaultRuntime.log(`${theme.command(result.name)} is not installed.`);
          return;
        }
        defaultRuntime.log(`${theme.success("Removed")} ${theme.command(result.name)}`);
      } catch (err) {
        reportSkillCommandError(err);
      }
    });

  skills
    .command("status")
    .description("List all loaded skills and readiness (bundled/workspace/managed)")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option("-v, --verbose", "Show more details including missing requirements", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsList(report, opts));
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      await runSkillsAction((report) => formatSkillInfo(report, name, opts));
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      await runSkillsAction((report) => formatSkillsCheck(report, opts));
    });

  // Default action (no subcommand) - show managed installs
  skills.action(async () => {
    try {
      const result = await listManagedSkills();
      defaultRuntime.log(
        renderManagedSkillsList({
          skills: result.skills,
          warning: result.warning,
        }),
      );
    } catch (err) {
      reportSkillCommandError(err);
    }
  });
}
