# ristretto

A [pi](https://github.com/earendil-works/pi) extension that lets the model keep its own context small.

Like the coffee: same content, less water. The model works through a task list. When a task is finished, it replaces the steps it took (file reads, tool output, attempts that failed) with a short handoff. Later requests then run on a smaller context, which makes them cheaper and keeps the model focused on what is still open.

## How it works

The extension adds one tool, `todos`, which does two things:

- **Task list:** the model adds tasks, marks them in progress or done, and keeps a list of standing rules from the user. The list is shown above the editor.
- **Compaction:** the same call can remove a stretch of finished work. The model names where the stretch starts with a tag, and writes a handoff that records what was done, what changed and why. Steps inside the stretch that open tasks still need (a spec, an interface) can be listed in `keep`: they stay as they are while the rest goes. When a task is completed, ristretto shows the open tasks around it so the model can decide what to keep.

Tags like `[#12]` are added to what the model sees: one per user request, one per step (tool result), and `[#0]` for the start of the context. The model copies a tag to say where a cut begins, so it never has to count messages.

### Prompt cache friendly

- Cuts fall between whole messages, never inside one.
- Everything before a cut stays byte-identical, so it is still a prompt cache hit. Only the new tail (handoff plus later messages) is written again.
- A compaction is only accepted when the removed range is large enough (`minCompactTokens`), so small steps are batched into one cut instead of each paying for its own handoff. Below a context budget (`contextBudgetTokens`) ristretto asks for no compaction at all: a small context is cheap to read, and every cut risks the model reading a removed file again.

### Nothing gets lost

- The raw session is never changed. Compaction uses pi's context edits, so the full history stays on disk and edits follow branches.
- User requests removed by a cut are carried verbatim into the handoff. A request that hasn't been answered yet comes back in full.
- Handoffs from earlier compactions inside a new range are replaced by the new handoff, so they don't pile up.
- A second tool, `recall`, lets the model look up an exact detail (code, an error message, what the user said) from removed history. A helper model (the newest Haiku by default) searches the removed steps and returns the matching original text.

### Reminders

Below the budget the model only knows a short tool description: compact a failed attempt or superseded output so it can't mislead. Once the context is over budget, a hidden note gives the full instructions (what to compact when, what a handoff holds); it comes again if a compaction removed it. From then on the model is reminded to update the list or compact after a stretch of uncompacted work, and before a request ends when finished work is still in context. The reminders are hidden from the user.

## Install

```bash
pi install git:github.com/JanWosnitza/ristretto
# or from a local clone
pi install ./ristretto
```

or add the folder to `packages` in `~/.pi/agent/settings.json`. Restart pi afterwards.

## Commands

| Command | Description |
|---|---|
| `/todos` | Show the full task list: open and finished tasks, earlier requests and rules |
| `/ristretto-stats` | Show compactions and cache usage for this session |
| `/ristretto-config [key value]` | Show or set options |

## Configuration

Options are stored in `~/.pi/agent/ristretto.json`. Only values that differ from the defaults are written.

| Option | Default | Description |
|---|---|---|
| `contextBudgetTokens` | 40000 | Below this context size no compaction is asked for (0 = always ask) |
| `minCompactTokens` | 800 | Smallest range a compaction may remove |
| `reminderEveryTokens` | 25000 | Remind the model to compact after this many tokens since the last compaction (0 = off) |
| `nudgeUncompactedTokens` | 2000 | Once per request, ask for the task list after this much tool work without a `todos` call (0 = off) |
| `checkBeforeEnd` | true | Before a request ends, ask for a compaction when enough finished work is still in context |
| `settledCheckTokens` | 4000 | Also ask when earlier requests and kept handoffs add up to this many tokens (0 = off) |
| `stripCompactThinking` | true | Drop the thinking of the message that called a compaction |
| `todoPanel` | `above` | Where the task list is shown: `above`, `below`, `side` or `off` |
| `sideWidth` | 36 | Width of the side panel in columns |
| `sideMinTerminalWidth` | 120 | Below this terminal width the side panel falls back to `above` |
| `cacheLifetime` | `1h` | How long the provider keeps the prompt cache: `5m` or `1h` |
| `log` | true | Write usage and compactions to `~/.pi/agent/ristretto/log.jsonl` |
| `recallModel` | (empty) | Helper model for `recall` as `provider/id`. Empty means the newest Haiku of the current provider |
| `recallMaxTokens` | 3000 | Most original text attached to a `recall` answer |
| `recallMaxInputTokens` | 150000 | Most removed history sent to the `recall` helper, capped at 60% of the helper's context window. If the prompt is still too long, recall halves the amount and retries |

## Trade-offs

- After a compaction the model may read a file again that it had already read before the cut.
- Writing the handoff costs output tokens. The profit check keeps this to compactions that are worth it.

## Development

```sh
npm install
npm run check   # typecheck
npm test        # unit tests (node --test)
```

## License

MIT, see [LICENSE](LICENSE).
