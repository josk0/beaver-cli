---
name: beaver
description: Ask Beaver, the research assistant in the user's Zotero, a question about their library and get an answer with citations. Use when the answer depends on the user's own Zotero library (papers, notes, collections).
---

# Beaver

Use `beaver` when the answer depends on what is in the user's Zotero library: which papers they
have on a topic, what a paper or note says, with citations. It has no library operations of its
own (tagging, moving, importing): use a Zotero MCP server for those. Each `-p` call runs Beaver's
agent and spends the user's Beaver credits: one call per question.

## 1. Check readiness

`beaver status --json` → ready when `reachable && beaver_available && error == null`. Otherwise
tell the user `error.next_step` (start Zotero, switch on 'Terminal and script access' in Beaver's
advanced settings, sign in); do not try to start Zotero or change its settings.

## 2. Ask

```
beaver -p --json "What do my papers say about algorithmic fairness?"
beaver -p --json -r <thread_id> "And the newer ones?"      # follow-up in the same chat
beaver -p --json --item ABCD1234 "Summarise this item"     # attach an item (g<groupID>:KEY for a group)
beaver threads --json [words]                               # saved chats; --after <next_cursor> pages on
```

`-p` takes the prompt as its value or as the last argument; `--json` may come before or after.
The prompt can also come from stdin. `--timeout <seconds>` (default 600) bounds a run.

Success: `-p` results have `status == "ok"`; `status`, `threads`, `windows` and `apply` have
`error == null`. With `--json`, stdout is always exactly one JSON object and stderr is empty.
Continue a chat with `-r <thread_id>` from the earlier result. `-c` takes the most recently
updated chat of the account, which may be another session's: prefer `-r`.

## 3. Read the result

- `answer`: Markdown. Citations appear inline as `(<display_name>[, pages][; …])`; each
  `display_name` equals one `sources[].display_name`.
- `sources[]` belongs to THIS answer: `n` is its order here, not stable across a chat. `pages` are
  the printed page numbers cited, absent when the source was cited as a whole. `library_ref` is `u`
  for the personal library, `g<groupID>` for a group; `library_ref` + `item_key` identify an item
  and `zotero_uri` opens it. `references` is the same sources as one formatted text block.
- `thread_id`: the chat, for `-r`; null unless Beaver confirmed it. `run_id`, `sent_run_id`: logs only.
- `applied_actions` (changes Beaver made without asking, by default a new note) and
  `declined_actions` (changes it asked about, declined automatically): `type` is Beaver's action
  type (`create_note`, `edit_note`, `create_item`, …), `status` one of `pending`, `applied`,
  `rejected`, `undone`, `error`, `unknown`. Report both to the user.
- `unresolved_items[]`: `--item`s not sent (`not_found`, `library_unavailable`,
  `library_excluded`, `rejected`). `warnings`: sentences to show the user.
- **Ask the user before running an `apply_command`** (`beaver apply <action-id> -r <thread_id>`):
  applying changes their library.

## 4. Errors (`error.code`, exit code)

| Group | Codes (exit) | What to do |
|---|---|---|
| Nothing was sent | `usage` (2), `zotero_unreachable` (10), `beaver_unavailable`, `not_authenticated` (11), `no_window` (12), `thread_not_found`, `thread_other_instance` (14) | Fix the cause or tell the user (`error.next_step`), then retry. |
| Nothing was sent: the window is in use | `busy_run`, `busy_draft`, `busy_attachments`, `busy_cards`, `thread_busy`, `thread_conflict` (13) | Wait 30–60 s and retry, at most 3 tries; then tell the user. |
| A run happened, credits were spent | `run_error` (16), `timeout` (17), `stopped` (18), `unsupported_pause` (19), `window_changed` (22), `protocol` (21) after a send | Do not resend automatically; show the partial `answer` and tell the user. |
| Unknown | `send_unknown` (15) | Never resend; tell the user to check the Zotero window. |

Other codes (`send_failed`, `library_excluded` 15; `account_changed`, `library_access_changed`
20; `run_not_found` and other 21s): tell the user `error.message` and `error.next_step`.

## Caution

- **Script mode is not read-only.** Beaver may apply changes without asking (by default, creating
  a note). Check `applied_actions` after every call; do not ask Beaver to change the library
  (notes, tags, collections, annotations) unless the user asked for that.
- A message carries only the items given with `--item`; the window's draft, staged items, open PDF
  and open note stay out of it and are left alone. The chat also appears in the Zotero window.
