---
name: group-plan
description: Read and maintain the user-facing plan of a ChatBot CustomChat group through the `manage_group_plan` tool.
metadata:
  { "openclaw": { "emoji": "🗂️", "requires": { "config": ["plugins.entries.customchat.enabled"] } } }
---

# Group Plan

Use this skill when the user asks you to inspect, update, or clear the concise progress plan of a ChatBot group.

## Tool

Use `manage_group_plan` for all group plan actions.

## Workflow

1. If the user asks for the current progress of a group, call `manage_group_plan` with `action="get_plan"`.
2. If the user asks you to maintain or revise the group plan, call `manage_group_plan` with `action="update_plan"`.
3. Keep the summary concise and user-facing. Do not paste the full discussion transcript into the plan.
4. Plan items should be short and actionable. Prefer 3-6 items unless the user explicitly wants more detail.
5. If you update the plan from a role context and your role name is known, pass it as `updatedByLabel`.
6. If the user asks to remove stale plan content, call `manage_group_plan` with `action="clear_plan"`.

## Supported actions

- `get_plan`
- `update_plan`
- `clear_plan`

## Examples

Read a group's current plan:

```json
{
  "action": "get_plan",
  "panelTitle": "博客开发群"
}
```

Update a group's plan:

```json
{
  "action": "update_plan",
  "panelTitle": "博客开发群",
  "updatedByLabel": "TeamLead",
  "summary": "技术方案已确定，RD 正在接分类标签表单，剩余发布页联调。",
  "items": [
    { "title": "技术方案确定", "status": "done" },
    { "title": "分类/标签表单接入", "status": "in_progress" },
    { "title": "公开页发布联调", "status": "pending" }
  ]
}
```

Clear a group's plan:

```json
{
  "action": "clear_plan",
  "panelTitle": "博客开发群"
}
```
