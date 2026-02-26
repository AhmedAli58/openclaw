---
summary: "CLI reference for `openclaw skills` registry install, updates, and readiness checks"
read_when:
  - You want to install or update managed skills from the registry
  - You want to inspect loaded skill readiness and requirements
title: "skills"
---

# `openclaw skills`

Manage installed skills in `~/.openclaw/skills` and inspect loaded skill readiness.

Related:

- Skills system: [Skills](/tools/skills)
- Skills config: [Skills config](/tools/skills-config)
- Doctor: [Doctor](/cli/doctor)

## Commands

```bash
openclaw skills search <query>
openclaw skills install <name>
openclaw skills install self-improving-agent --init
openclaw skills list
openclaw skills update <name>
openclaw skills remove <name>
openclaw skills status
openclaw skills status --eligible
openclaw skills info <name>
openclaw skills check
```

## Command details

- `skills search <query>`: search the remote `openclaw/skills` registry.
- `skills install <name> [--force] [--init]`: install a skill into `~/.openclaw/skills/<name>`.
- `skills list`: list installed managed skills with version, path, and update status.
- `skills update <name>`: update one installed managed skill.
- `skills remove <name>`: remove one installed managed skill (workspace files are preserved).
- `skills status`: show loaded skills (bundled/workspace/managed) and readiness requirements.
- `skills info <name>`: show detailed readiness info for one loaded skill.
- `skills check`: show readiness summary counts.

## Self improving agent quick start

```bash
openclaw skills install self-improving-agent --init
```

`--init` creates `~/.openclaw/workspace/.learnings/` with:

- `LEARNINGS.md`
- `ERRORS.md`
- `FEATURE_REQUESTS.md`
