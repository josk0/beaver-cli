# Reference

The output of `beaver --json` and the exit codes. `beaver --help` prints the same information;
[`skills/beaver/SKILL.md`](../skills/beaver/SKILL.md) says how an agent should act on it.

## The answer: `beaver -p --json`

Exactly one object on one stdout line, also on failure; stderr stays empty. (`--help` prints the
help text instead.)

```
{ "schema_version": 1, "status": "ok" | "error",
  "thread_id", "thread_name", "run_id", "sent_run_id", "answer", "references",
  "sources": [{ "n", "display_name", "reference", "item_key", "library_ref", "zotero_uri", "pages"? }],
  "applied_actions": [{ "id", "type", "status" }],
  "declined_actions": [{ "id", "type", "status", "apply_command" }],
  "unresolved_items": [{ "library_ref"?, "item_key", "status" }],
  "warnings": [string],
  "error": null | { "code", "message", "next_step" } }
```

| Field | Meaning |
|---|---|
| `status` | `"ok"` on success, else `"error"` |
| `answer` | Markdown. Citations appear inline as `(<display_name>[, pages][; ...])`; each `display_name` equals one `sources[].display_name`. On error: the partial text, if any |
| `references` | the sources as one formatted text block |
| `sources` | the sources of this answer. `n` is the order in this answer, not stable across a chat. `pages`: the printed page numbers cited, absent when the source was cited as a whole. `library_ref` is `u` (personal library) or `g<groupID>` (group); `library_ref` and `item_key` identify an item; `zotero_uri` opens it |
| `thread_id` | the chat; pass it to `-r` to continue. Null unless Beaver confirmed the chat |
| `thread_name` | the chat's name, when known |
| `run_id`, `sent_run_id` | for logs. `run_id` is the run that answered; it differs from `sent_run_id` when Beaver resumed the run under a new id |
| `applied_actions` | changes of this run that Beaver applied without asking (by default, a new note) |
| `declined_actions` | changes of this run that Beaver asked about and script mode declined. `apply_command` applies one later (null while the chat has no id) |
| `type`, `status` of an action | `type` is Beaver's action type (`create_note`, `edit_note`, `create_item`, ...); `status` is `pending`, `applied`, `rejected`, `undone`, `error` or `unknown` |
| `unresolved_items` | items given with `--item` that were not sent; `status` is `not_found`, `library_unavailable`, `library_excluded` or `rejected` |
| `warnings` | sentences to show the user |
| `error` | null on success; else a `code` (see the exit codes), a `message` and a `next_step` |

Text mode (no `--json`) prints the answer, then `Sources:` and the list, on stdout; the line
`Chat: <thread_id>`, applied and declined changes, warnings and errors go to stderr.

## Other commands

Each prints one object with `schema_version: 1`; success is `error == null`.

| Command | Fields |
|---|---|
| `beaver status --json` | `reachable`, `beaver_available`, `plugin_version`, `interface_version`, `default_window_id`, `windows` (a count), `error`. Ready when `reachable && beaver_available && error == null` |
| `beaver windows --json` | `windows: [{ id, kind, status }]`, `default_window_id`, `error` |
| `beaver threads --json [words]` | `threads: [{ id, name, created_at, updated_at, pinned }]`, `has_more`, `next_cursor` (pass it to `--after` for the next page), `error` |
| `beaver apply <action-id> -r <thread-id> --json` | `thread_id`, `applied: [id]`, `failed: [{ action_id, error }]`, `error` |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected failure of the command itself |
| 2 | `usage`: wrong or missing arguments |
| 10 | `zotero_unreachable`: nothing answers on the port (Zotero not running, or another port) |
| 11 | `beaver_unavailable` ('Terminal and script access' is off, or the build has no such setting), `not_authenticated` (Beaver is signed out) |
| 12 | `no_window`: no (such) Zotero window runs Beaver |
| 13 | the window is in use, nothing was sent: `busy_run`, `busy_draft`, `busy_attachments`, `busy_cards`, `thread_busy`, `thread_conflict` |
| 14 | `thread_not_found`, `thread_other_instance`: the chat given with `-r` (or `-c`) could not be opened |
| 15 | `send_failed` (nothing was sent), `send_unknown` (the message may have been sent: check the window before sending it again), `library_excluded` |
| 16 | `run_error`: the run failed or needed a credit confirmation |
| 17 | `timeout`: no answer within `--timeout`; the command tries to stop its run (check `warnings`), partial answer returned |
| 18 | `stopped`: cancelled (Ctrl-C); the command tries to stop its run (check `warnings`), partial answer returned |
| 19 | `unsupported_pause`: the run needed an answer this command cannot give |
| 20 | `account_changed`, `library_access_changed` (the library exclusions in Beaver's settings changed) |
| 21 | `protocol`, and the unexpected refusals `run_not_found`, `action_not_found`, `action_not_pending`, `use_approve`, `duplicate_run` |
| 22 | `window_changed`: the window switched to another chat during the call; the run continues there |
