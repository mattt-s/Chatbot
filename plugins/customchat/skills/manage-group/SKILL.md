---
name: manage-group
description: Create and manage ChatBot CustomChat groups and group roles through the `manage_group` tool.
metadata:
  { "openclaw": { "emoji": "👥", "requires": { "config": ["plugins.entries.customchat.enabled"] } } }
---

# Group Management

Use this skill when the user asks you to create or delete a group, add/remove members, assign a leader, inspect available groups or agents, check a group's task state, or send a user message into a group in the ChatBot app.

## Tool

Use `manage_group` for all group management actions.

## Workflow

1. If the user asks to create a group and provides all required details, call `manage_group` with `action="create_group"`, `title`, and `roles`.
2. If the user asks to add/remove/update members, delete a group, query task state, or send a message into an existing group but only gives a group name, call `manage_group` with `action="list_groups"` first when the group name may be ambiguous.
3. If the user does not know which agentId to bind to a role, call `manage_group` with `action="list_agents"` first and then map a suitable agentId.
4. To inspect one group's current task status and members, call `manage_group` with `action="get_group_task_state"`.
5. To make the group receive a new instruction as if it came from the user, call `manage_group` with `action="send_group_message"` and a concise message.
6. If a required field is missing, ask one short follow-up question instead of guessing IDs or names.
7. After the tool succeeds, answer briefly and mention the affected group name, role names, task state, or sent message as appropriate.
8. Treat `roleId` and `roleTitle` as different fields. `roleTitle` is a human-readable name such as `ui`, `rd`, or `techlead`. `roleId` is the system identifier and usually looks like a long UUID such as `360f80e3-c405-4f9d-a362-40f1d245f6bb`. Never copy a role title into `roleId`.
9. If you are not fully sure about a role's real `roleId`, prefer using only `roleTitle`, or call `list_groups` first to inspect the real IDs.

## Supported actions

- `list_agents`
- `list_groups`
- `create_group`
- `delete_group`
- `get_group_task_state`
- `send_group_message`
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

Update one role's title by real roleId:

```json
{
  "action": "update_group_role",
  "panelId": "05bb3e8a-2451-43fd-ac38-71d68ec684a2",
  "roleId": "360f80e3-c405-4f9d-a362-40f1d245f6bb",
  "title": "UI"
}
```

Temporarily disable a role (remove from group routing without deleting):

```json
{
  "action": "update_group_role",
  "panelTitle": "博客开发群",
  "roleTitle": "QA",
  "enabled": false
}
```

Re-enable a previously disabled role:

```json
{
  "action": "update_group_role",
  "panelTitle": "博客开发群",
  "roleTitle": "QA",
  "enabled": true
}
```

Incorrect example, do not do this:

```json
{
  "action": "update_group_role",
  "panelTitle": "博客开发群",
  "roleId": "ui"
}
```

Get one group's task state:

```json
{
  "action": "get_group_task_state",
  "panelTitle": "博客开发群"
}
```

Send a new instruction into the group as a user message:

```json
{
  "action": "send_group_message",
  "panelTitle": "博客开发群",
  "message": "请两位同步一下今天的开发进展和阻塞项。"
}
```

Delete a group:

```json
{
  "action": "delete_group",
  "panelTitle": "博客开发群"
}
```
