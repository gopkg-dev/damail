---
title: MCP
description: Give Claude, Cursor and other AI agents access to your mail over MCP
---

DaMail has a built-in MCP server (Streamable HTTP) at `https://your-domain/mcp`. Agents authenticate with an API key or [OAuth](/docs/oauth/).

## Create an API key

Create a key under **Settings → API keys** and choose its permissions and mailboxes. The key starts with `dm_` and is shown only once.

## Add it to your client

Claude Code:

```bash
claude mcp add --transport http damail https://mail.example.com/mcp \
  --header "Authorization: Bearer dm_xxx"
```

Claude Desktop, Cursor and others use JSON:

```json
{
  "mcpServers": {
    "damail": {
      "type": "http",
      "url": "https://mail.example.com/mcp",
      "headers": { "Authorization": "Bearer dm_xxx" }
    }
  }
}
```

Clients that cannot take an API key, such as ChatGPT, sign in with OAuth — see [ChatGPT and OAuth](/docs/oauth/).

## Permissions

| Permission | Allows | Tools |
|---|---|---|
| `read` (always included) | Read mail, threads, attachments, drafts, stats, reports and contacts | `list_accounts` `list_folders` `search_emails` `semantic_search` `get_email` `get_thread` `get_attachment` `get_stats` `list_waiting` `list_subscriptions` `list_contacts` `translate_email` `get_report` `list_reports` `list_drafts` `get_draft` |
| `organize` | Mark read / starred, archive, trash, move, follow-up reminders | `mark_emails` `move_emails` `set_follow_up` `clear_follow_up` |
| `draft` | Write drafts, reply, forward, submit for approval, cancel | `create_draft` `update_draft` `delete_draft` `request_send` `cancel_send` |
| `send` | Send without approval (still with an undo window), unsubscribe | `send_draft` `unsubscribe` |
| `automation` | View, dry-run, create, update and delete inbox rules; manage the ignore list; list notification channels (without secrets) | `list_rules` `test_rule` `create_rule` `update_rule` `delete_rule` `list_channels` `list_ignored_senders` `ignore_sender` `unignore_sender` |

- Tools a key is not allowed to use are **not registered** at all, and every call is checked again on the server
- A key limited to some mailboxes only sees their mail, and can only manage rules that apply to those mailboxes
- Keys can only change drafts they created; approving or rejecting happens in the web app only
- Model and notification channel settings contain secrets and can only be managed in the web app

## Sending with and without `send`

Here is what happens when an agent sends the same test email:

| | Without `send` | With `send` |
|---|---|---|
| Tools | `request_send` | `request_send` and `send_draft` |
| What happens | The email goes to **Drafts → Awaiting approval** and is sent only after you approve it in the web app | The email is sent after `SEND_DELAY_SEC` seconds (10 by default), with no approval step |
| How you stop it | Edit, approve or reject it | Undo it within the delay window |
| Limits | None needed | Over [OAuth](/docs/oauth/), each grant can send at most 10 emails per hour (adjustable in settings, 0 turns direct sending off). API keys have no hourly cap, so grant `send` to a key with care |

Even with `send`, the MCP instructions tell agents to use `request_send` unless you explicitly ask them to send directly.

## Safety

- **Approval before sending**: by default, mail written by an agent goes to “Awaiting approval” for you to edit, approve or reject. Only keys with `send` can send directly, and there is still a `SEND_DELAY_SEC` undo window (see [Sending with and without `send`](#sending-with-and-without-send))
- **Mail is untrusted**: the MCP instructions tell agents to treat message bodies as data and never follow instructions inside them
- **Audit log**: every API and MCP call is recorded under **Audit**, filterable by key

With AI analysis enabled, results from `get_email`, `get_thread` and `search_emails` include `insight` (category, priority, summary and extracted details).
