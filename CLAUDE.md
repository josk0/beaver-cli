# beaver-cli

Terminal client for the chat agent of the Beaver Zotero plugin. User documentation: `README.md`;
JSON and exit codes: `docs/reference.md`. The routes it
uses, `/beaver/chat/*`, are built in the plugin fork
(https://github.com/josk0/beaver-zotero/tree/cli-chat-routes); their source and
`docs/chat-routes.md` there are the contract. Personal notes, if any, are in `CLAUDE.local.md`
(git-ignored).

## Commands

| Task | Command |
|---|---|
| Unit tests (no Zotero, no network) | `npm test` |
| Typecheck (src and tests) | `npm run typecheck` |
| Build `dist/` | `npm run build` |
| Run from source | `npm run beaver -- <args>` |
| Dev helper: run the built `beaver` against a second, test Zotero from any directory (rebuilds `dist/` when stale; exits 10 if nothing answers) | `scripts/beaver-test <args>` (port `BEAVER_PORT`, default 23126) |
| Live tests | `BEAVER_PORT=<port> npm run test:live > <file> 2>&1`, then read the `Tests` line |

## Constraints

- Live tests and every real `beaver` call run Beaver's agent on a real account and spend Beaver
  credits: at most four agent runs per execution of the live suite. No prompt in a test may ask
  for a library change. Live tests skip themselves when `BEAVER_PORT` is unset, so "skipped" is
  not a pass. They need a running, signed-in Zotero with a build of the fork branch and 'Terminal
  and script access' on; test 1 expects the item `PVX9VYC4` in the personal library.
- A plain-text 404 on `/beaver/chat/*` means 'Terminal and script access' is off; a 401
  `not_authenticated` means Beaver is signed out.
- Run identity: the command names its run (`run_id`, a UUID) in `send` and never sends a message
  twice, also after an unknown outcome. `status` and `stop` may answer a newer run id (a resume);
  the session adopts it. `stop` is called only in `src/core/session.ts`: the ask's `stopOurRun` (by
  run id, so only our run) and the interactive `/stop` (`ChatSession.stop`, by chat id). Every
  status, approve and stop names the chat once its id is known, so a window that switched chats
  answers `window_changed`. Keep these properties in any change.
- `src/client` and `src/core` do no terminal I/O. `runCli` never calls `process.exit`.
- With `--json`: exactly one JSON object on one stdout line, in every case except `--help`, which
  prints the help text.
- The JSON output is versioned (`schema_version`). A change to its fields or to the exit codes
  must update `src/cli.ts` (the help text), `docs/reference.md` and `skills/beaver/SKILL.md`
  together.
- Code conventions follow the Beaver repository's `beaver-extract` tool (TypeScript, `commander`,
  `vitest`, an in-process `runCli` test seam), so the code can move there later.
- Test data must contain no personal data: fake chat and run ids, no account ids, e-mail
  addresses, tokens or machine paths. Bibliographic data and Zotero item keys are fine.

## Open work

1. The plugin branch may need reshaping into reviewable steps.
2. Not verified live: answers to Beaver's questions and credit confirmations through `approve`
   (tested against the fake server only); the `send_unknown` path; paste over ssh or mosh at the
   interactive prompt (lines are joined by timing); a production build of the fork (the live
   checks used a staging build).
3. Server gaps the command works around: a failed run that Beaver retries from the start gets a new
   run id with no link to ours (the command reports `run_error`); `status` does not list batch
   approvals or tables (the command gives up after 15 s with `unsupported_pause`).
4. A Zotero blocked by a dialog makes the command wait about a minute (three 15 s status timeouts,
   then the stop) before it returns.
5. `sources[].pages` holds printed page labels; labels that are not numbers (for example "iv") are
   dropped there.
6. A send that is still starting cannot be cancelled: `stop` answers `stopped:false` for it, so the
   run may start after the command gave up (`send_unknown`, with a warning).
7. Option, not decided: in interactive mode, dim Beaver's progress sentences (the text before a tool
   line) so the final answer stands out. Also not rendered: links and tables.
