---
name: manage-group
description: Create and manage ChatBot CustomChat groups and group roles through the `manage_group` tool.
metadata:
  { "openclaw": { "emoji": "👥", "requires": { "config": ["plugins.entries.customchat.enabled"] } } }
---

# Group Management

Use this skill when the user asks you to create a group, add/remove members, assign a leader, or inspect available groups/agents in the ChatBot app.

## Tool

Use `manage_group` for all group management actions.

## Workflow

1. If the user asks to create a group and provides all required details, call `manage_group` with `action="create_group"`, `title`, and `roles`.
2. If the user asks to add/remove/update members in an existing group but only gives a group name, call `manage_group` with `action="list_groups"` first when the group name may be ambiguous.
3. If the user does not know which agentId to bind to a role, call `manage_group` with `action="list_agents"` first and then map a suitable agentId.
4. If a required field is missing, ask one short follow-up question instead of guessing IDs or names.
5. After the tool succeeds, answer briefly and mention the created group name, role names, and who is leader.

## Supported actions

- `list_agents`
- `list_groups`
- `create_group`
- `add_group_role`
- `update_group_role`
- `set_group_leader`
- `unset_group_leader`
- `remove_group_role`

## Examples

Create a new group with three roles:

```json
{
  "action": "create_group",
  "title": "博客开发群",
  "roles": [
    { "title": "PM", "agentId": "main", "isLeader": true },
    { "title": "架构师", "agentId": "main" },
    { "title": "RD", "agentId": "main" }
  ]
}
```

Add one member to an existing group:

```json
{
  "action": "add_group_role",
  "panelTitle": "博客开发群",
  "title": "QA",
  "agentId": "main"
}
```

Set a leader by role title:

```json
{
  "action": "set_group_leader",
  "panelTitle": "博客开发群",
  "roleTitle": "PM"
}
```
