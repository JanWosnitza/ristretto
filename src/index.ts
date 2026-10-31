/**
 * ristretto: a todo list the model works through, which also keeps its context small.
 *
 * One tool, `todos`: the model keeps its task list up to date (add tasks, set status, keep the
 * user's standing rules). The same call can compact: everything from a tag up to the call leaves
 * the context, and the call's handoff plus the current task list are the record of it.
 *
 * Tags: each user message gets a request tag [#n] at its end (added to what the model sees
 * only, identical on every request), one tool result per step gets a step tag [#n], and [#0]
 * marks the start of the context. A cut removes the tagged message too; a request not answered
 * yet comes back verbatim in the result. Tags of removed messages still work: the cut starts where they were.
 *
 * Cuts fall between whole messages, and the context up to a cut stays byte-identical, so it is
 * still a prompt-cache hit; only the new tail is written.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { estimateTokens, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---- configuration --------------------------------------------------------------------------

interface Config {
	/** Below this context size (message tokens) ristretto asks for no compaction: no end check, nudge, reminder or hint. 0 = always ask. */
	contextBudgetTokens: number;
	/** Smallest span (tokens) a compaction may remove. */
	minCompactTokens: number;
	/** Remind the model to compact after this many tokens since the last compaction. 0 disables. */
	reminderEveryTokens: number;
	/** Once per request: ask for the task list after this much tool work without a todos call. 0 disables. */
	nudgeUncompactedTokens: number;
	/** Before a request ends: ask for a compaction when at least minCompactTokens of its steps are not compacted. */
	checkBeforeEnd: boolean;
	/** Before a request ends: also ask when earlier requests and kept compaction handoffs add up to this many tokens. 0 disables. */
	settledCheckTokens: number;
	/** Drop the thinking of the message that called a compaction: it reasons about the removed work. */
	stripCompactThinking: boolean;
	/** Where the task list is shown: above or below the editor, as a floating panel on the right (side), or off. */
	todoPanel: "above" | "below" | "side" | "off";
	/** Side panel: width in columns, and the terminal width below which it falls back to "above". */
	sideWidth: number;
	sideMinTerminalWidth: number;
	/** How long the provider keeps the prompt cache: "5m" or "1h". */
	cacheLifetime: "5m" | "1h";
	/** Write one JSON line per request with its usage, and one per compaction. */
	log: boolean;
	/** recall: helper model as "provider/id"; empty = the newest Haiku of the current provider, else the current model. */
	recallModel: string;
	/** recall: most original text attached to an answer, in tokens. */
	recallMaxTokens: number;
	/** recall: most removed history sent to the helper, in tokens. */
	recallMaxInputTokens: number;
}

const DEFAULTS: Config = {
	contextBudgetTokens: 40_000,
	minCompactTokens: 800,
	reminderEveryTokens: 25_000,
	nudgeUncompactedTokens: 2_000,
	checkBeforeEnd: true,
	settledCheckTokens: 4_000,
	stripCompactThinking: true,
	todoPanel: "above",
	sideWidth: 36,
	sideMinTerminalWidth: 120,
	cacheLifetime: "1h",
	log: true,
	recallModel: "",
	recallMaxTokens: 3_000,
	recallMaxInputTokens: 150_000,
};

const CONFIG_FILE = join(getAgentDir(), "ristretto.json");
const LOG_FILE = join(getAgentDir(), "ristretto", "log.jsonl");

function loadConfig(): Config {
	try {
		if (existsSync(CONFIG_FILE)) return { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, "utf8")) };
	} catch {}
	return { ...DEFAULTS };
}

function saveConfig(c: Config): void {
	const diff = Object.fromEntries(Object.entries(c).filter(([k, v]) => (DEFAULTS as any)[k] !== v));
	writeFileSync(CONFIG_FILE, `${JSON.stringify(diff, null, 2)}\n`);
}

// ---- todo list --------------------------------------------------------------------------------

type Status = "pending" | "in_progress" | "completed" | "cancelled";

interface Todo {
	/** Book-style number: "2" for a task, "2.3" for its third subtask, "2.3.1" below that. */
	id: string;
	text: string;
	status: Status;
	/** Tag current when the task was started: where its steps begin. */
	since?: number;
	/** Tag current when the task was completed. */
	doneAt?: number;
}

interface TodoState {
	todos: Todo[];
	rules: string[];
	/** Next top-level number; numbers stay unique after finished tasks are archived. */
	nextId?: number;
}

const emptyState = (): TodoState => ({ todos: [], rules: [] });

const parentOf = (id: string) => (id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : undefined);
const depthOf = (id: string) => id.split(".").length - 1;
const inSubtree = (id: string, root: string) => id === root || id.startsWith(`${root}.`);
const isOpen = (t: Todo) => t.status === "pending" || t.status === "in_progress";
const childrenOf = (todos: Todo[], id: string) => todos.filter((t) => parentOf(t.id) === id);
const byNumber = (a: Todo, b: Todo) => {
	const x = a.id.split(".").map(Number);
	const y = b.id.split(".").map(Number);
	for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? -1) - (y[i] ?? -1);
	return 0;
};

/** " (3/4)" for a task with subtasks: completed of not cancelled. */
function progressOf(todos: Todo[], id: string): string {
	const kids = childrenOf(todos, id).filter((t) => t.status !== "cancelled");
	return kids.length > 0 ? ` (${kids.filter((t) => t.status === "completed").length}/${kids.length})` : "";
}

/** Older sessions stored numeric ids. */
function normalizeState(s: any): TodoState {
	return { todos: (s?.todos ?? []).map((t: any) => ({ ...t, id: String(t.id) })), rules: s?.rules ?? [], nextId: s?.nextId };
}
const STATE_TYPE = "ristretto-todos-state";
// Sessions written before the rename use "context-rewind-" custom types.
const isType = (t: unknown, type: string) => t === type || t === type.replace(/^ristretto-/, "context-rewind-");
const PANEL_KEY = "ristretto-todos";
const PANEL_MODES = ["above", "below", "side", "off"];

/** Maps a tag to the one the model can see (a tag removed by a compaction shows as the first visible tag after it). */
type TagView = (tag: number) => number;
const asIs: TagView = (tag) => tag;

function lineOf(todos: Todo[], t: Todo, show: TagView = asIs): string {
	const mark = t.status === "in_progress" ? "[>]" : t.status === "completed" ? "[x]" : "[ ]";
	const since = t.status === "in_progress" && t.since ? ` (since #${show(t.since)})` : "";
	return `${"  ".repeat(depthOf(t.id))}${mark} ${t.id} ${t.text}${progressOf(todos, t.id)}${since}`;
}

function renderList(s: TodoState, listCompleted: number, show: TagView = asIs): string {
	const lines: string[] = [];
	const todos = [...s.todos].sort(byNumber);
	// Finished top-level tasks are listed compactly at the end, without their subtasks.
	const done = todos.filter((t) => !parentOf(t.id) && t.status === "completed");
	for (const t of todos) {
		if (t.status === "cancelled" || done.some((d) => inSubtree(t.id, d.id))) continue;
		lines.push(lineOf(todos, t, show));
	}
	if (done.length > 0) {
		const named = done.slice(-listCompleted).map((t) => `${t.id} ${t.text}${progressOf(todos, t.id)}`);
		lines.push(`done (${done.length}): ${named.join("; ")}${done.length > named.length ? "; …" : ""}`);
	}
	if (lines.length === 0) lines.push("(no tasks)");
	if (s.rules.length > 0) lines.push(`rules: ${s.rules.join(" | ")}`);
	return lines.join("\n");
}

/** The task being worked on (with its parents and open subtasks), the tasks named in `changed`, and counts for the rest. */
function renderCompact(s: TodoState, changed: Set<string>, withRules: boolean, show: TagView = asIs): string {
	const todos = [...s.todos].sort(byNumber);
	const shown = new Set<string>();
	const withParents = (id: string) => {
		for (let p: string | undefined = id; p; p = parentOf(p)) shown.add(p);
	};
	for (const t of todos) {
		if (t.status !== "in_progress") continue;
		withParents(t.id);
		for (const c of childrenOf(todos, t.id)) if (isOpen(c)) shown.add(c.id);
	}
	for (const id of changed) if (todos.some((t) => t.id === id && t.status !== "cancelled")) withParents(id);
	const lines = todos.filter((t) => shown.has(t.id)).map((t) => lineOf(todos, t, show));
	const open = todos.filter((t) => isOpen(t) && !shown.has(t.id)).length;
	const done = todos.filter((t) => !parentOf(t.id) && t.status === "completed").length;
	const rest = [open > 0 ? `${open} more open` : "", done > 0 ? `${done} done this request` : ""].filter(Boolean).join(", ");
	if (lines.length === 0 && !rest) lines.push("(no tasks)");
	if (rest) lines.push(`${rest}; todos() without arguments lists everything.`);
	if (withRules && s.rules.length > 0) lines.push(`rules: ${s.rules.join(" | ")}`);
	return lines.join("\n");
}

/** The open tasks around completed ones: at each level from the task up to the root, the open siblings, plus the parent chain. */
function renderAround(s: TodoState, completed: Todo[], show: TagView = asIs): string {
	const todos = [...s.todos].sort(byNumber);
	const shown = new Set<string>();
	for (const t of completed) {
		for (let id: string | undefined = t.id; id; id = parentOf(id)) {
			const p = parentOf(id);
			if (p) shown.add(p);
			for (const sib of todos) if (parentOf(sib.id) === p && isOpen(sib)) shown.add(sib.id);
		}
	}
	return todos.filter((t) => shown.has(t.id) && isOpen(t)).map((t) => lineOf(todos, t, show)).join("\n");
}

/** Open tasks for the head of a new request: top-level tasks and the path of the task in progress. */
function renderHead(s: TodoState, show: TagView = asIs): string {
	const todos = [...s.todos].sort(byNumber);
	const active = todos.filter((t) => t.status === "in_progress");
	const lines = todos
		.filter((t) => isOpen(t) && (!parentOf(t.id) || active.some((a) => inSubtree(a.id, t.id))))
		.map((t) => lineOf(todos, t, show));
	return lines.length > 0 ? `[ristretto] Open tasks:\n${lines.join("\n")}` : "";
}

// ---- helpers ---------------------------------------------------------------------------------

type Block = { type: string; [k: string]: any };
type Projected = { sourceEntry: any; messages: any[] };

/** The step tag of a tool result: its own text block "[#n]" (other text may mention tags too). */
function stepTagOf(content: unknown): number | undefined {
	if (!Array.isArray(content)) return undefined;
	for (let i = content.length - 1; i >= 0; i--) {
		const b = content[i];
		const t = b?.type === "text" ? /^\[#(\d+)\]$/.exec(String(b.text).trim()) : null;
		if (t) return Number(t[1]);
	}
	return undefined;
}

// pi records the system prompt as a message once a run starts; it is neither work nor removable.
const tokensOf = (messages: any[]) => messages.reduce((n, m) => n + (m.role === "system" ? 0 : estimateTokens(m)), 0);
const first = (e: Projected | undefined) => e?.messages[0];
const toolCalls = (m: any): Block[] => (m?.role === "assistant" ? (m.content as Block[]).filter((b) => b.type === "toolCall") : []);
const visible = (e: Projected) => !!first(e) && first(e).role !== "system";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: any) => (b?.type === "text" ? b.text : "")).join("\n");
}

/** Removed user requests, verbatim, for the compaction result. They stay one generation: a later compaction removes the
 * result, and its handoff folds them in. Over the cap, the oldest are cut to their first line. */
function removedRequests(msgs: any[], tags: Map<number, number>, capChars = 6000, eachChars = 800): string {
	const reqs = msgs
		.filter((m) => m?.role === "user" && tags.has(m.timestamp))
		.map((m) => ({ tag: tags.get(m.timestamp)!, text: textOf(m.content).trim() }))
		.filter((r) => r.text);
	if (reqs.length === 0) return "";
	const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [...]` : s);
	let lines = reqs.map((r) => ({ tag: r.tag, text: cut(r.text, eachChars), short: cut(r.text.split("\n")[0], 150) }));
	let total = lines.reduce((n, l) => n + l.text.length, 0);
	for (const l of lines) {
		if (total <= capChars) break;
		total -= l.text.length - l.short.length;
		l.text = l.short;
	}
	const head =
		"USER REQUESTS removed with that range, verbatim (shortened if long). This is the only record of what the user asked and the reasons they gave. A later compaction that covers this result deletes it: that handoff MUST restate each request below in one line, including the user's reason.";
	return (
		`\n\n${head}\n` +
		lines.map((l) => `[#${l.tag}] ${l.text}`).join("\n")
	);
}

/** The request being worked on, verbatim: a cut that removes it attaches it to the result, again after every later cut,
 * until it is answered. Only then does it go the way of the other removed requests. */
function currentRequest(m: any, tags: Map<number, number>): string {
	const text = textOf(m?.content).trim();
	if (!text) return "";
	const tag = tags.get(m.timestamp);
	return `\n\nTHE REQUEST YOU ARE WORKING ON, verbatim. It is not answered yet: answer it. It is shown again after every compaction until you answer.\n${tag ? `[#${tag}] ` : ""}${text}`;
}

/** A projected entry's message, also for omitted entries (the projection lists them without messages). */
// Identifies a message in the context hook, which has no entry ids.
const msgKey = (m: any) => (m.role === "toolResult" ? `r:${m.toolCallId}` : `${m.role}:${m.timestamp}`);

// A compaction held back as too small: applied without the model once the prompt cache has expired.
interface Deferred {
	omit: string[];
	keys: string[];
	removedTokens: number;
	text: string;
}

const messageOf = (e: Projected | undefined) => first(e) ?? (e?.sourceEntry.type === "message" ? e.sourceEntry.message : undefined);

/** Where the context begins after pi's own last compaction: a cut may not cross it. */
function historyStart(entries: Projected[]): number {
	let base = 0;
	entries.forEach((e, i) => {
		if (e.sourceEntry.type === "compaction") base = i + 1;
	});
	return base;
}

/**
 * Where a cut from the tagged entry `i` begins, also when that entry is already removed. The tagged message goes too.
 * A step of an earlier request takes that whole request: a request left without its answer, or with half its steps,
 * reads as unfinished work.
 */
function cutStart(entries: Projected[], i: number, current: number): number {
	const base = historyStart(entries);
	if (messageOf(entries[i])?.role === "user") return Math.max(i, base);
	let s = i;
	while (s > base && messageOf(entries[s])?.role !== "assistant") s--;
	if (s < current) {
		let r = s;
		while (r > base && messageOf(entries[r])?.role !== "user") r--;
		s = r;
	}
	return Math.max(s, base);
}

function lastUserIndex(entries: Projected[], before = entries.length): number {
	// Removed prompts count: a cut may remove the request being worked on.
	for (let i = before - 1; i >= 0; i--) if (messageOf(entries[i])?.role === "user") return i;
	return -1;
}

const CLOSE_TYPE = "ristretto-close";

// Full compaction instructions: sent once the context is over budget and not already in it.
// Below the budget the model only knows the short tool description, so it does not compact for size.
const HOWTO_MARK = "[ristretto] Your context has grown.";
const HOWTO =
	`${HOWTO_MARK} From now on keep it small with todos compact_from + handoff:\n` +
	"- Compact every finished stretch of steps whose raw details you no longer need: a completed task, a lookup done to answer a question, an exploration, a failed attempt. " +
	"When you mark a task completed, compact its steps in the same todos call (compact_from = the tag where that work began). " +
	"When a subtask is completed, compact its steps before you start the next one.\n" +
	"- Before you compact finished work, check what the open tasks still need from it (a spec, an interface, a reference): " +
	"list those steps in keep, so they stay as they are while the rest of the range goes. Keep only what open work will read again.\n" +
	"- Steps you only needed to answer a question: compact them before your answer, with everything the answer needs in the handoff (tasks are optional).\n" +
	"- Finished conversation counts too: questions you answered, decisions made, handoffs of earlier compactions. When earlier requests are settled, compact from their request tag. " +
	"The removed range can include earlier requests of the user; then the task list (and rules) must cover what they asked for.\n" +
	"- The handoff covers ONLY the removed range: what was done or found (concrete results), files created or changed and their state, " +
	"for each change one line on why it was made (and which alternatives were rejected), what did not work. " +
	"Open work (next steps, follow-ups, things to do later) goes into the task list, never into the handoff: the task list is the only record of what is still open. " +
	"The user's requests removed with the range are shown verbatim in the result once; when a later compaction covers them, fold them in: what was asked and why, one line each. " +
	"Include every detail that still matters, at whatever length that takes; text you will quote or reuse goes in verbatim. " +
	"You still see the steps while you write it, but not afterwards. Do not describe how you got there.\n" +
	"- If the range contains earlier compactions, their handoffs are removed with it and yours replaces them: keep from them what still matters, " +
	"drop intermediate states the later work superseded; open work they mention that is still open becomes a task.";

/** The pre-end check of the current request: index of its prompt, and of the answer right before it. */
function closeCheckOf(entries: Projected[], before = entries.length): { prompt: number; answer: number } | undefined {
	const req = lastUserIndex(entries, before);
	for (let i = before - 1; i > req; i--) {
		const m = first(entries[i]);
		if (m?.role === "custom" && isType(m.customType, CLOSE_TYPE)) return first(entries[i - 1])?.role === "assistant" ? { prompt: i, answer: i - 1 } : undefined;
	}
	return undefined;
}

const REQUEST_TAG_TYPE = "ristretto-request-tag";
const ANSWER_NOTE_TYPE = "ristretto-answer-note";

// For tests.
export { cutStart, DEFAULTS, isType, removedRequests, renderCompact, renderList, stepTagOf };

// ---- extension ---------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();
	let nextTag = 1;
	/** user message timestamp -> request tag */
	const requestTags = new Map<number, number>();
	/** Open tasks as they were when a request arrived, shown with it (fixed, so the cached prefix stays the same). */
	const requestHeads = new Map<number, string>();
	/** answer timestamp -> handoff of an end-check compaction, shown in front of that answer to the model only. */
	const answerNotes = new Map<number, string>();
	let state = emptyState();
	/** todos toolCallId -> compaction to apply at the end of the turn. */
	const pending = new Map<string, { omit: string[]; removedTokens: number; close?: { promptId: string; answerTs: number; note: string } }>();
	const stats = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, compactions: 0, removedTokens: 0 };
	/** The current run: context size at its start, and whether it compacted or the model was nudged. */
	let usageGap = 0;
	let cold: { omit: string[]; keys: Set<string>; results: Map<string, { id: string; text: string }>; removedTokens: number } | undefined;
	let run = { startTokens: 0, compacted: false, nudged: false, closeAsked: false, closing: false, closeTotal: 0 };
	/** First step tag of work done while no task was in progress (in this request, since the last compaction). */
	let untrackedFrom: number | undefined;
	/** Tokens since the last compaction when the last reminder was given. */
	let lastReminder = 0;
	/** Settled tokens when the model last chose to keep them at the end check: ask again only after more piled up. */
	let settledKept = 0;

	const log = (ctx: ExtensionContext, record: object) => {
		if (!cfg.log) return;
		try {
			mkdirSync(dirname(LOG_FILE), { recursive: true });
			appendFileSync(LOG_FILE, `${JSON.stringify({ t: new Date().toISOString(), session: ctx.sessionManager.getSessionId(), ...record })}\n`);
		} catch {}
	};

	const projection = (ctx: ExtensionContext): Projected[] => ctx.sessionManager.buildSessionProjection().entries as Projected[];

	// ---- task list display ----------------------------------------------------------------------

	/** Tasks archived when a new request started, oldest first (for /todos). */
	let archived: Todo[] = [];
	/** The installed panel: its mode and renderer, so updates only re-render. */
	let panel: { mode: string; tui: TUI } | undefined;

	/** One line per task, indented by depth; subtasks of finished top-level tasks are folded away. */
	function treeLines(theme: Theme, todos: Todo[], fold: boolean): string[] {
		const sorted = [...todos].sort(byNumber);
		const foldedRoots = fold ? sorted.filter((t) => !parentOf(t.id) && !isOpen(t)) : [];
		const lines: string[] = [];
		for (const t of sorted) {
			if (t.status === "cancelled" && fold) continue;
			if (foldedRoots.some((r) => r.id !== t.id && inSubtree(t.id, r.id))) continue;
			const ind = "  ".repeat(depthOf(t.id));
			const label = `${t.id} ${t.text}${progressOf(sorted, t.id)}`;
			if (t.status === "completed") lines.push(theme.fg("dim", `${ind}✓ ${label}`));
			else if (t.status === "cancelled") lines.push(theme.fg("dim", `${ind}✗ ${label}`));
			else if (t.status === "in_progress") lines.push(`${ind}${theme.fg("accent", "▶")} ${label}`);
			else lines.push(`${ind}${theme.fg("muted", "○")} ${label}`);
		}
		return lines;
	}

	function panelLines(theme: Theme, width: number): string[] {
		const roots = state.todos.filter((t) => !parentOf(t.id) && t.status !== "cancelled");
		const done = roots.filter((t) => t.status === "completed").length;
		const lines = [theme.fg("accent", `Tasks ${done}/${roots.length}`) + theme.fg("dim", "  /todos"), ...treeLines(theme, state.todos, true)];
		return lines.map((l) => truncateToWidth(l, Math.max(1, width)));
	}

	/** Side panel: padded to its full width so it covers the chat text below it. */
	function sideLines(theme: Theme, width: number): string[] {
		const inner = Math.max(4, width - 2);
		const pad = (s: string) => s + " ".repeat(Math.max(0, inner - visibleWidth(s)));
		const bar = theme.fg("borderMuted", "│");
		return panelLines(theme, inner).map((l) => truncateToWidth(`${bar} ${pad(l)}`, width));
	}

	function updateWidget(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const mode = PANEL_MODES.includes(cfg.todoPanel) ? cfg.todoPanel : "above";
		if (state.todos.length === 0 || mode === "off") {
			if (panel) ctx.ui.setWidget(PANEL_KEY, undefined);
			panel = undefined;
			return;
		}
		if (panel?.mode === mode) {
			panel.tui.requestRender();
			return;
		}
		const placement = mode === "below" ? "belowEditor" : "aboveEditor";
		ctx.ui.setWidget(
			PANEL_KEY,
			(tui, theme) => {
				panel = { mode, tui };
				if (mode !== "side") return { render: (w: number) => panelLines(theme, w), invalidate() {} };
				// No side column exists in pi: a non-capturing overlay floats over the chat's right edge. On narrow
				// terminals it hides and the widget above the editor shows the list instead.
				const wide = () => tui.terminal.columns >= cfg.sideMinTerminalWidth;
				const handle = tui.showOverlay(
					{ render: (w: number) => sideLines(theme, w), invalidate() {} },
					{ anchor: "top-right", width: cfg.sideWidth, margin: { top: 1, right: 1 }, nonCapturing: true, visible: () => wide() },
				);
				return { render: (w: number) => (wide() ? [] : panelLines(theme, w)), invalidate() {}, dispose: () => handle.hide() };
			},
			{ placement },
		);
	}

	/** A new request starts a fresh list: finished top-level tasks are archived with their subtasks, open ones carry over. */
	function archiveFinished(ctx: ExtensionContext) {
		const roots = state.todos.filter((t) => !parentOf(t.id) && !isOpen(t));
		const finished = state.todos.filter((t) => roots.some((r) => inSubtree(t.id, r.id)));
		if (finished.length === 0) return;
		const nextId = state.todos.reduce((n, t) => (parentOf(t.id) ? n : Math.max(n, Number(t.id))), (state.nextId ?? 1) - 1) + 1;
		state = { todos: state.todos.filter((t) => !finished.includes(t)), rules: state.rules, nextId };
		archived.push(...finished);
		pi.appendEntry(STATE_TYPE, { state, archived: finished });
		updateWidget(ctx);
	}

	async function showFullList(ctx: ExtensionContext) {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(renderList(state, Number.MAX_SAFE_INTEGER), "info");
			return;
		}
		await ctx.ui.custom<void>(
			(tui, theme, _kb, done) => {
				let scroll = 0;
				const body = (width: number) => {
					const w = Math.max(10, width - 2);
					const out: string[] = [];
					const head = (s: string) => out.push("", theme.fg("accent", s));
					// Full text, wrapped: continuation lines keep the task's indentation.
					const tree = (todos: Todo[]) => {
						for (const line of treeLines(theme, todos, false)) {
							const ind = " ".repeat(visibleWidth(line) - visibleWidth(line.trimStart()) + 2);
							const [firstLine, ...rest] = wrapTextWithAnsi(line, w);
							out.push(firstLine, ...rest.flatMap((l) => wrapTextWithAnsi(ind + l.trimStart(), w)));
						}
					};
					const openRoots = state.todos.filter((t) => !parentOf(t.id) && isOpen(t));
					const open = state.todos.filter((t) => openRoots.some((r) => inSubtree(t.id, r.id)));
					const finished = state.todos.filter((t) => !open.includes(t));
					head(`Open (${openRoots.length})`);
					if (open.length === 0) out.push(theme.fg("dim", "none"));
					else tree(open);
					if (finished.length > 0) {
						head(`Done in this request (${finished.filter((t) => !parentOf(t.id)).length})`);
						tree(finished);
					}
					if (archived.length > 0) {
						head(`Earlier requests (${archived.filter((t) => !parentOf(t.id)).length})`);
						tree(archived);
					}
					if (state.rules.length > 0) {
						head(`Rules (${state.rules.length})`);
						for (const r of state.rules) out.push(...wrapTextWithAnsi(`• ${r}`, w));
					}
					return out.map((l) => ` ${l}`);
				};
				return {
					render(width: number) {
						const lines = body(width);
						const room = Math.max(5, Math.floor(tui.terminal.rows * 0.8) - 3);
						scroll = Math.min(scroll, Math.max(0, lines.length - room));
						const more = lines.length > room ? "  ↑/↓ scroll" : "";
						return [
							theme.fg("accent", " Task list") + theme.fg("dim", `   esc/q close${more}`),
							...lines.slice(scroll, scroll + room),
						].map((l) => truncateToWidth(l, width));
					},
					handleInput(data: string) {
						if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "q") return done();
						if (matchesKey(data, "up")) scroll = Math.max(0, scroll - 1);
						else if (matchesKey(data, "down")) scroll++;
						else return;
						tui.requestRender();
					},
					invalidate() {},
				};
			},
			{ overlay: true, overlayOptions: { anchor: "center", width: "70%", minWidth: 40, maxHeight: "80%" } },
		);
	}

	/** Rebuild tags and the task list from the active branch (raw entries: removed ones still count). */
	function restore(ctx: ExtensionContext) {
		nextTag = 1;
		requestTags.clear();
		requestHeads.clear();
		answerNotes.clear();
		state = emptyState();
		archived = [];
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			if (e.type === "custom" && isType(e.customType, STATE_TYPE)) {
				state = normalizeState(e.data.state);
				archived.push(...normalizeState({ todos: e.data.archived }).todos);
				continue;
			}
			if (e.type === "custom" && isType(e.customType, REQUEST_TAG_TYPE)) {
				requestTags.set(e.data.ts, e.data.tag);
				if (e.data.head) requestHeads.set(e.data.ts, e.data.head);
				nextTag = Math.max(nextTag, e.data.tag + 1);
			}
			if (e.type === "custom" && isType(e.customType, ANSWER_NOTE_TYPE)) answerNotes.set(e.data.ts, e.data.note);
			if (e.type !== "message" || e.message.role !== "toolResult") continue;
			const t = stepTagOf(e.message.content);
			if (t) nextTag = Math.max(nextTag, t + 1);
			if (e.message.toolName === "todos" && e.message.details?.state) state = normalizeState(e.message.details.state);
		}
	}

	// ---- tags -------------------------------------------------------------------------------------

	// Request tags: assigned when the user message is stored, shown in front of it to the model.
	pi.on("message_end", async (event, ctx) => {
		const m: any = event.message;
		if (m.role === "user" && typeof m.timestamp === "number" && !requestTags.has(m.timestamp)) {
			const tag = nextTag++;
			requestTags.set(m.timestamp, tag);
			const head = renderHead(state, tagView(ctx));
			if (head) requestHeads.set(m.timestamp, head);
			pi.appendEntry(REQUEST_TAG_TYPE, { ts: m.timestamp, tag, ...(head ? { head } : {}) });
		}
		if (m.role !== "assistant" || !m.usage) return;
		const u = m.usage;
		stats.requests++;
		stats.input += u.input;
		stats.output += u.output;
		stats.cacheRead += u.cacheRead;
		stats.cacheWrite += u.cacheWrite;
		stats.cost += u.cost?.total ?? 0;
		log(ctx, { kind: "request", model: m.model, input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, stop: m.stopReason });
	});

	pi.on("context", async (event) => {
		let changed = false;
		let source = event.messages;
		// Cold-cache cuts of this request: saved as context edits at turn_end, until then applied here.
		if (cold) {
			const c = cold;
			changed = true;
			source = source
				.filter((m: any) => !c.keys.has(msgKey(m)))
				.map((m: any) => {
					const r = m.role === "toolResult" ? c.results.get(m.toolCallId) : undefined;
					return r ? { ...m, content: [{ type: "text", text: r.text }] } : m;
				});
		}
		// [#0] marks where the context begins: at the end of pi's summary, or in front of the first message.
		const start = source.findIndex((m: any) => m.role !== "system");
		const messages = source.map((m: any, i: number) => {
			if (i === start && (m.role === "compactionSummary" || m.role === "branchSummary")) {
				changed = true;
				return { ...m, summary: `${m.summary}\n\n[#0]` };
			}
			const zero = i === start && m.role === "user" ? [{ type: "text", text: "[#0]" }] : [];
			if (m.role === "assistant") {
				const note = answerNotes.get(m.timestamp);
				if (!note) return m;
				changed = true;
				const lead = m.content.filter((b: Block) => b.type === "thinking" || b.type === "redacted_thinking");
				const rest = m.content.filter((b: Block) => !lead.includes(b));
				return { ...m, content: [...lead, { type: "text", text: note }, ...rest] };
			}
			if (m.role !== "user") return m;
			const tag = requestTags.get(m.timestamp);
			if (!tag && zero.length === 0) return m;
			changed = true;
			const head = tag ? requestHeads.get(m.timestamp) : undefined;
			const prefix = [...zero, ...(head ? [{ type: "text", text: head }] : [])];
			const suffix = tag ? [{ type: "text", text: `[#${tag}]` }] : [];
			const body = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
			return { ...m, content: [...prefix, ...body, ...suffix] };
		});
		if (changed) return { messages };
	});

	// Step tags: one result per step, the first that is not a todos call, so the tag sits on the work.
	pi.on("tool_result", async (event, ctx) => {
		if (event.parentToolCallId) return;
		const branch = ctx.sessionManager.getBranch() as any[];
		for (let i = branch.length - 1; i >= 0; i--) {
			const m = branch[i].type === "message" ? branch[i].message : undefined;
			if (m?.role !== "assistant") continue;
			const calls = toolCalls(m);
			if (!calls.some((b) => b.id === event.toolCallId)) continue;
			const tagged = calls.find((b) => b.name !== "todos") ?? calls[0];
			if (tagged.id !== event.toolCallId) return;
			if (tagged.name !== "todos" && untrackedFrom === undefined && !state.todos.some((t) => t.status === "in_progress")) untrackedFrom = nextTag;
			const note = tagged.name === "todos" || tagged.name === "recall" ? undefined : noteFor(ctx);
			const extra = note ? [{ type: "text" as const, text: note }] : [];
			return { content: [...event.content, ...extra, { type: "text", text: `[#${nextTag++}]` }] };
		}
	});

	// ---- todos ------------------------------------------------------------------------------------

	/** Tags as the model sees them: a tag that a compaction removed becomes the first visible tag after it. */
	function tagView(ctx: ExtensionContext): TagView {
		const seen = projection(ctx)
			.filter(visible)
			.map((e) => {
				const m = first(e);
				return m.role === "user" ? requestTags.get(m.timestamp) : m.role === "toolResult" ? stepTagOf(m.content) : undefined;
			})
			.filter((t): t is number => t !== undefined);
		return (tag) => (tag === 0 || seen.includes(tag) ? tag : (seen.find((t) => t > tag) ?? tag));
	}

	/** Compactions of a completed task's earlier steps that lie before this compaction's range: named, never removed. */
	function nestedNote(entries: Projected[], start: number, completed: Todo[]): string {
		const notes: string[] = [];
		for (const t of completed) {
			if (!t.since) continue;
			const sinceIdx = entries.findIndex((e) => {
				const m = first(e);
				return (m?.role === "user" && requestTags.get(m.timestamp) === t.since) || (m?.role === "toolResult" && stepTagOf(m.content) === t.since);
			});
			if (sinceIdx < 0 || sinceIdx >= start) continue;
			const froms = entries
				.slice(sinceIdx, start)
				.filter((e) => visible(e) && first(e)?.role === "toolResult" && first(e).toolName === "todos" && first(e).details?.compacted)
				.map((e) => {
					const call = entries.flatMap((x) => toolCalls(first(x))).find((b) => b.id === first(e).toolCallId);
					return Number(/\d+/.exec(String(call?.arguments?.compact_from ?? ""))?.[0]);
				})
				.filter((f) => f > 0);
			if (froms.length > 0) {
				notes.push(
					` Task ${t.id} began at [#${t.since}], before this range: ${froms.length} compaction(s) of its earlier steps (from ${froms.map((f) => `[#${f}]`).join(", ")}) stay in your context. ` +
						`A compaction from #${t.since} would merge them into one handoff.`,
				);
			}
		}
		return notes.join("");
	}

	pi.registerTool({
		name: "todos",
		label: "Tasks",
		description:
			"Your task list for this session. Each call updates it and shows the task in progress, the tasks you changed, and counts for the rest; " +
			"call it without arguments to see the whole list. Each new request of the user starts with the open tasks.\n" +
			"- items: add tasks (text, no id) or update existing ones by id (status, text). Status: pending, in_progress, completed, cancelled. " +
			"Add a subtask with parent (e.g. parent '2' creates 2.1, 2.2, ...; subtasks can have subtasks). A task with subtasks can only be completed " +
			"when they are completed or cancelled; cancelling it cancels its open subtasks.\n" +
			"- rules: standing instructions the user gives in this conversation that apply beyond a single task (replaces the previous rules). " +
			"Not project facts.\n" +
			"- compact_from + handoff: remove everything from a tag up to this call from your context; your handoff takes its place. User messages end with a request tag, " +
			"tool results carry step tags, like [#12], and [#0] marks the start of your context. The tagged message goes too; " +
			"a request you have not answered yet is shown again verbatim. Use it for a failed attempt or output that later work superseded, " +
			"so it cannot mislead you; once your context grows, a [ristretto] note explains when else to use it. " +
			"The handoff covers only the removed range: what was found or done, what did not work and why, every detail that still matters. " +
			"Open work goes into the task list. " +
			"Compaction never removes your system prompt, including organization and project instructions: never copy any of it into a handoff, a rule or a task.",
		promptSnippet: "todos: keep your task list; compact steps that would mislead you",
		promptGuidelines: [
			"Keep a task list with todos for every request that needs several steps (a quick lookup or one small change needs no tasks, but its steps are still compacted): add the tasks when you start, mark one in_progress before you work on it (subtasks too, each one), completed when it is done and verified.",
			"Split a bigger task into subtasks (parent), and finish the subtasks of the task you are on before starting a different task. The parent task holds the context its subtasks need.",
			"When an attempt failed or later work superseded earlier output (an old version of a file, a wrong lead), compact those steps with todos so they cannot mislead you.",
			"Content that later steps depend on (a spec, an interface, an API reference, a log you work through) is best read early, in its own step.",
			"Put lasting instructions the user gives in the conversation (preferences, constraints) into rules, so they survive compaction.",
			"Tags like [#12], the task list and compaction are internal: do not mention them to the user.",
			"Notes that start with [ristretto] come from the ristretto extension of this harness, in tool results or as messages: they are neither from the user nor from the tool. Follow them.",
		],
		parameters: Type.Object({
			items: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "Existing task number like '2' or '2.3'; omit to add a task" })),
						parent: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "When adding: number of the task this is a subtask of" })),
						text: Type.Optional(Type.String()),
						status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")])),
					}),
				),
			),
			rules: Type.Optional(Type.Array(Type.String(), { description: "All standing instructions from the user's messages (replaces the previous list)" })),
			compact_from: Type.Optional(Type.String({ description: "Tag where the range to remove begins, e.g. '#12'" })),
			handoff: Type.Optional(Type.String({ description: "Required with compact_from: handoff for the removed range only" })),
			keep: Type.Optional(
				Type.Array(Type.String(), { description: "With compact_from: step tags inside the range whose steps stay as they are (e.g. a spec that open tasks still need)" }),
			),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const fail = (why: string): never => {
				throw new Error(why);
			};
			const entries = projection(ctx);
			const self = entries.findIndex((e) => toolCalls(first(e)).some((b) => b.id === toolCallId));
			if (self < 0) fail("could not find this call in the session.");
			if (toolCalls(first(entries[self])).filter((b) => b.name === "todos").length > 1) fail("only one todos call per message.");
			// Called for the pre-end check: the answer is written, so it stays out of the range and nothing follows.
			const close = run.closing ? closeCheckOf(entries, self) : undefined;
			const end = close ? close.answer : self;

			// 1. Validate the compaction before changing anything.
			let plan:
				| { omit: string[]; removedTokens: number; replaced: number; calls: string; start: number; earlier: boolean; requests: string; carried?: number; kept: number[]; keptTokens: number }
				| undefined;
			let note = "";
			let compactFrom = 0;
			let deferred: Deferred | undefined;
			if (params.keep?.length && params.compact_from === undefined) fail("keep needs compact_from.");
			if (params.compact_from !== undefined) {
				if (!params.handoff?.trim()) fail("compact_from needs a handoff.");
				const digits = /^\s*\[?#?(\d+)\]?\s*$/.exec(params.compact_from)?.[1];
				if (digits === undefined) fail(`"${params.compact_from}" is not a tag like #12.`);
				const tag = Number(digits);
				compactFrom = tag;
				// The request being worked on: a cut may remove it, but until it is answered it is attached verbatim.
				const current = lastUserIndex(entries, self);
				let start: number;
				if (tag === 0) start = historyStart(entries);
				else {
					// Removed entries count too: a tag that an earlier compaction removed starts the cut where it was.
					const tagged = entries.findIndex((e, i) => {
						const m = messageOf(e);
						return i < self && ((m?.role === "user" && requestTags.get(m.timestamp) === tag) || (m?.role === "toolResult" && stepTagOf(m.content) === tag));
					});
					if (tagged < 0) fail(`no tag [#${tag}] before this call.`);
					start = cutStart(entries, tagged, current);
				}
				if (start >= end) fail(`tag [#${tag}] lies after your answer.`);
				const all = entries.slice(start, end);
				if (all.some((e) => e.sourceEntry.type === "compaction")) fail("a compaction happened in that range.");
				// Kept steps: the assistant message whose result carries the tag, and all its results.
				const keptIdx = new Set<number>();
				const kept: number[] = [];
				for (const k of params.keep ?? []) {
					const d = /^\s*\[?#?(\d+)\]?\s*$/.exec(k)?.[1];
					if (d === undefined) fail(`keep: "${k}" is not a tag like #12.`);
					const kt = Number(d);
					const at = entries.findIndex((e, i) => i >= start && i < end && visible(e) && first(e).role === "toolResult" && stepTagOf(first(e).content) === kt);
					if (at < 0) fail(`keep: [#${kt}] is not a step tag inside the range.`);
					let s = at;
					while (s > start && first(entries[s])?.role !== "assistant") s--;
					if (first(entries[s])?.role !== "assistant") fail(`keep: the step of [#${kt}] starts before the range.`);
					if (toolCalls(first(entries[s])).some((b) => b.name === "todos")) fail(`keep: [#${kt}] is a step with a todos call; keep only steps with content.`);
					let e = at;
					while (e + 1 < end && (!visible(entries[e + 1]) || first(entries[e + 1]).role === "toolResult")) e++;
					for (let i = s; i <= e; i++) keptIdx.add(i);
					kept.push(kt);
				}
				const span = all.filter((_, j) => !keptIdx.has(start + j));
				// Answered (the pre-end check): the request is removed like any other. Not yet: it comes back verbatim.
				// Covered: its own message, or an earlier result of this request that carried it.
				const promptMsg = current >= 0 ? messageOf(entries[current]) : undefined;
				// Requests carried by earlier results in the range (details.carried = the prompt's timestamp).
				const carriedTs = span
					.map(first)
					.filter((m) => m?.role === "toolResult" && m.toolName === "todos" && typeof m.details?.carried === "number")
					.map((m) => m.details.carried as number);
				const covers = !!promptMsg && (start <= current || carriedTs.includes(promptMsg.timestamp));
				const currentMsg = covers ? promptMsg : undefined;
				const carried = !close && currentMsg ? currentRequest(currentMsg, requestTags) : "";
				// A carried request answered since then is removed like any other: shown once, then restated.
				const answered = [...new Set(carriedTs)]
					.filter((ts) => ts !== promptMsg?.timestamp)
					.map((ts) => entries.map(messageOf).find((m) => m?.role === "user" && m.timestamp === ts))
					.filter(Boolean);
				const others = [...answered, ...span.filter((e) => e !== entries[current]).map(first)];
				const requests = removedRequests(close && currentMsg ? [...others, currentMsg] : others, requestTags) + carried;
				const removed = tokensOf(span.flatMap((e) => e.messages));
				// A recall result is looked up to answer this request: removing it before the answer turns an
				// exact quote back into a paraphrase.
				const recallNow = entries.slice(Math.max(start, current + 1), self).some((e) => first(e)?.role === "toolResult" && first(e).toolName === "recall");
				if (recallNow) {
					note = "\n\nNot compacted: the range contains a recall result from this request. Answer the user from it; it is removed automatically after your answer.";
				} else if (removed < cfg.minCompactTokens) {
					note = `\n\nNot compacted: only ~${removed} tokens would be removed. Continue normally.`;
					// Held back while the cache is warm; applied without the model once it has expired.
					const msgs = span.filter(visible).map(first);
					if (!close && !requests && params.keep === undefined && msgs.every((m) => m.role === "assistant" || m.role === "toolResult")) {
						deferred = {
							omit: span.filter(visible).map((e) => e.sourceEntry.id),
							keys: msgs.map(msgKey),
							removedTokens: removed,
							text: "",
						};
					}
				} else {
					const omit = span.filter(visible).map((e) => e.sourceEntry.id);
					// Earlier compactions in the range go with it; the new handoff replaces theirs.
					const replaced = span.filter((e) => first(e)?.role === "toolResult" && first(e).toolName === "todos" && first(e).details?.compacted).length;
					const counts = new Map<string, number>();
					for (const e of span) for (const b of toolCalls(first(e))) if (b.name !== "todos") counts.set(b.name, (counts.get(b.name) ?? 0) + 1);
					const calls = [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");
					plan = { omit, removedTokens: removed, replaced, calls, start, earlier: start < current, requests, carried: carried ? currentMsg.timestamp : undefined, kept, keptTokens: tokensOf([...keptIdx].flatMap((i) => entries[i].messages)) };
				}
			}

			// 2. Update the list (on a copy: a failure leaves the list unchanged).
			const next: TodoState = { todos: state.todos.map((t) => ({ ...t })), rules: params.rules ?? state.rules };
			let maxRoot = next.todos.reduce((n, t) => (parentOf(t.id) ? n : Math.max(n, Number(t.id))), (state.nextId ?? 1) - 1);
			const num = (v: string | number | undefined) => (v === undefined ? undefined : String(v).trim().replace(/^#/, ""));
			const find = (id: string) => next.todos.find((x) => x.id === id) ?? fail(`no task ${id}.`);
			const completedNow: Todo[] = [];
			const unstarted: string[] = [];
			const hints: string[] = [];
			const startedNow: Todo[] = [];
			const changed = new Set<string>();
			const start = (t: Todo) => {
				// Work done before the task was started belongs to it.
				if (!t.since) t.since = untrackedFrom ?? nextTag;
				untrackedFrom = undefined;
				if (t.status !== "in_progress") startedNow.push(t);
				t.status = "in_progress";
				// Working on a subtask means working on its parents.
				for (let p = parentOf(t.id); p; p = parentOf(p)) {
					const parent = find(p);
					if (parent.status === "pending") {
						parent.status = "in_progress";
						parent.since ??= nextTag;
					}
				}
			};
			for (const it of params.items ?? []) {
				const id = num(it.id);
				let t: Todo;
				if (id === undefined) {
					if (!it.text?.trim()) fail("a new task needs text.");
					const parent = num(it.parent);
					let newId: string;
					if (parent) {
						find(parent);
						const n = childrenOf(next.todos, parent).reduce((m, c) => Math.max(m, Number(c.id.slice(parent.length + 1))), 0);
						newId = `${parent}.${n + 1}`;
					} else newId = String(++maxRoot);
					t = { id: newId, text: it.text!.trim(), status: "pending" };
					next.todos.push(t);
				} else {
					t = find(id);
					if (it.text?.trim()) t.text = it.text.trim();
				}
				changed.add(t.id);
				const status = it.status ?? (id === undefined ? "pending" : undefined);
				if (!status || status === t.status) continue;
				if (status === "in_progress") start(t);
				else {
					if (status === "completed") {
						completedNow.push(t);
						if (t.status === "pending") unstarted.push(t.id);
						t.doneAt = nextTag;
					}
					if (status === "cancelled") for (const d of next.todos) if (d.id !== t.id && inSubtree(d.id, t.id) && isOpen(d)) d.status = "cancelled";
					t.status = status;
				}
			}
			if (unstarted.length > 0 && params.compact_from === undefined) {
				hints.push(
					`Task${unstarted.length > 1 ? "s" : ""} ${unstarted.join(", ")} went from pending to completed without being started, so ${unstarted.length > 1 ? "their" : "its"} steps have no start tag. ` +
						"Mark each task in_progress before you work on it; then its steps can be compacted when it is done.",
				);
			}
			// Checked after all items, so subtasks and their parent can be completed in one call.
			for (const t of completedNow) {
				const open = next.todos.filter((d) => d.id !== t.id && inSubtree(d.id, t.id) && isOpen(d)).map((d) => d.id);
				if (open.length > 0) fail(`task ${t.id} still has open subtasks (${open.join(", ")}): complete or cancel them first. Nothing was changed.`);
			}
			next.nextId = maxRoot + 1;
			state = next;
			updateWidget(ctx);

			const view = tagView(ctx);
			// Notes that steer the order of work.
			for (const s of startedNow) {
				const unfinished = state.todos.find(
					(y) => y.status === "in_progress" && !inSubtree(s.id, y.id) && !inSubtree(y.id, s.id) && childrenOf(state.todos, y.id).some(isOpen),
				);
				if (unfinished) {
					const open = childrenOf(state.todos, unfinished.id).filter(isOpen).map((c) => c.id);
					hints.push(`Task ${unfinished.id} still has open subtasks (${open.join(", ")}). Finish them before working on ${s.id}, or set ${unfinished.id} back to pending if you deliberately switch.`);
				}
			}
			for (const p of new Set(completedNow.map((t) => parentOf(t.id)).filter((p): p is string => !!p))) {
				const parent = state.todos.find((t) => t.id === p);
				if (parent && isOpen(parent) && !childrenOf(state.todos, p).some(isOpen)) {
					hints.push(`All subtasks of ${p} are done: complete ${p} when its own work is done${parent.since ? `, and compact from #${view(parent.since)}` : ""}.`);
				}
			}

			const bare = !params.items?.length && params.rules === undefined && params.compact_from === undefined;
			let text = bare ? renderList(state, Number.MAX_SAFE_INTEGER, view) : renderCompact(state, changed, params.rules !== undefined || !!plan, view);
			if (hints.length > 0) text += `\n\n${hints.join("\n")}`;
			if (close) {
				// The handoff goes in front of the answer; the prompt, this call and its result are removed at turn_end.
				const handoffNote = plan
					? `[The steps from [#${compactFrom}]${plan.earlier ? ", earlier requests included," : " of this request"} were compacted (~${plan.removedTokens} tokens${plan.calls ? `; your tool calls there: ${plan.calls}` : ""}). ` +
						`You wrote this handoff while you saw them; its findings are exact. Handoff: ${params.handoff!.trim()}${plan.requests}]`
					: "";
				pending.set(toolCallId, {
					omit: plan?.omit ?? [],
					removedTokens: plan?.removedTokens ?? 0,
					close: { promptId: entries[close.prompt].sourceEntry.id, answerTs: first(entries[close.answer]).timestamp, note: handoffNote },
				});
				if (plan) untrackedFrom = undefined;
				settledKept = plan ? 0 : run.closeTotal;
				run.closing = false;
				const done = plan ? `Compacted ~${plan.removedTokens} tokens.` : `Kept the steps.${note}`;
				return { content: [{ type: "text", text: done }], details: { state, compacted: !!plan }, terminate: true } as any;
			}
			if (plan) {
				pending.set(toolCallId, { omit: plan.omit, removedTokens: plan.removedTokens });
				untrackedFrom = undefined;
				const from = compactFrom;
				// Name the work: without it, a list that jumps from "created" to "done" reads as if nothing was done.
				const doneInRange = [...state.todos].sort(byNumber).filter((t) => t.status === "completed" && (t.doneAt ?? 0) >= from);
				const doneText = doneInRange.length > 0 ? ` Tasks you completed in that range: ${doneInRange.map((t) => `${t.id} ${t.text}`).join("; ")}.` : "";
				text =
					`Compacted: the steps from [#${from}] up to this call (~${plan.removedTokens} tokens) were removed from your context${plan.calls ? ` (your tool calls there: ${plan.calls})` : ""}.${doneText} ` +
					`You did that work and its changes are in place; your handoff in this call and the task list below are its record. ` +
					`You wrote the handoff while you saw those steps: its findings and quotes are exact and need no checking again. Do not redo the work; answer the user from it.` +
					(plan.kept.length > 0 ? ` Kept as they are (~${plan.keptTokens} tokens): ${plan.kept.map((k) => `[#${k}]`).join(", ")}.` : "") +
					(plan.replaced > 0 ? ` The range contained ${plan.replaced} earlier compaction(s); your handoff replaces their handoffs.` : "") +
					plan.requests +
					nestedNote(entries, plan.start, completedNow) +
					`\n\nTasks:\n${text}`;
			} else {
				if (deferred) {
					deferred.text =
						`Tasks:\n${text}\n\nCompacted later, after the prompt cache had expired: the steps from [#${compactFrom}] up to this call (~${deferred.removedTokens} tokens) were removed from your context. ` +
						`Your handoff in this call is their record; its findings are exact.`;
				}
				text = `Tasks:\n${text}${note}`;
				if (completedNow.length > 0 && params.compact_from === undefined && overBudget(ctx)) {
					const since = completedNow.map((t) => t.since).filter((s): s is number => !!s);
					if (since.length > 0) {
						const around = renderAround(state, completedNow, view);
						text +=
							`\n\nIf the steps of the completed task(s) are no longer needed, compact them (from #${view(Math.min(...since))}).` +
							(around ? ` Open work around them:\n${around}\nPut the steps these tasks will read again in keep.` : "");
					}
					const howTo = howToFor(ctx);
					if (howTo) text += `\n\n${howTo}`;
				}
			}
			return { content: [{ type: "text", text }], details: { state, compacted: !!plan, carried: plan?.carried, ...(deferred ? { deferred } : {}) } };
		},
	});

	// ---- recall -------------------------------------------------------------------------------------

	interface Step {
		tag?: number;
		kind: "request" | "step";
		/** Full text, as the model saw it. */
		text: string;
	}

	const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}\n[... ${s.length - max} more characters]` : s);

	interface Compaction {
		from: number;
		/** Entries it removed, including those of earlier compactions it covered. */
		ids: Set<string>;
	}

	/**
	 * Compactions on the current branch. A compaction is a todos result with details.compacted; the omissions
	 * applied for it are the context_edit entries appended right after its turn.
	 */
	function compactions(ctx: ExtensionContext): Compaction[] {
		const branch = ctx.sessionManager.getBranch() as any[];
		const direct = new Map<string, { from: number; ids: Set<string> }>();
		let open: { from: number; ids: Set<string> } | undefined;
		const callFrom = new Map<string, number>();
		for (const e of branch) {
			if (e.type === "message") {
				const m = e.message;
				if (m.role === "assistant") {
					open = undefined;
					for (const b of m.content as Block[]) {
						const from = b.type === "toolCall" && b.name === "todos" ? Number(/\d+/.exec(String(b.arguments?.compact_from ?? ""))?.[0]) : NaN;
						if (Number.isInteger(from)) callFrom.set(b.id, from);
					}
				} else if (m.role === "toolResult" && m.toolName === "todos" && m.details?.compacted && callFrom.has(m.toolCallId)) {
					open = { from: callFrom.get(m.toolCallId)!, ids: new Set() };
					direct.set(e.id, open);
				} else if (m.role === "user") open = undefined;
			} else if (e.type === "context_edit" && e.replacement === null && open) {
				open.ids.add(e.targetId);
			}
		}
		// A compaction that covered earlier ones removed their entries too.
		const expand = (ids: Set<string>, seen: Set<string>): Set<string> => {
			const out = new Set(ids);
			for (const id of ids) {
				const inner = direct.get(id);
				if (inner && !seen.has(id)) {
					seen.add(id);
					for (const x of expand(inner.ids, seen)) out.add(x);
				}
			}
			return out;
		};
		return [...direct.entries()].filter(([, c]) => c.ids.size > 0).map(([id, c]) => ({ from: c.from, ids: expand(c.ids, new Set([id])) }));
	}

	/** The compaction a tag points to: the one that started at it, else the latest one whose range contains it. */
	function compactionFor(ctx: ExtensionContext, tag: number): Compaction | undefined {
		const all = compactions(ctx);
		const exact = all.filter((c) => c.from === tag);
		if (exact.length > 0) return exact[exact.length - 1];
		const tagged = new Set<string>();
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			if (e.type !== "message") continue;
			const m = e.message;
			if ((m.role === "user" && requestTags.get(m.timestamp) === tag) || (m.role === "toolResult" && stepTagOf(m.content) === tag)) tagged.add(e.id);
		}
		const containing = all.filter((c) => [...tagged].some((id) => c.ids.has(id)));
		return containing[containing.length - 1];
	}

	/** Messages of the current branch that are no longer in the model's context, grouped into steps. */
	function removedSteps(ctx: ExtensionContext, only?: (id: string) => boolean): Step[] {
		// The projection also lists omitted entries, with no messages.
		const kept = new Set(projection(ctx).filter((e) => e.messages.length > 0).map((e) => e.sourceEntry.id));
		const steps: Step[] = [];
		let cur: Step | undefined;
		for (const e of ctx.sessionManager.getBranch() as any[]) {
			if (e.type !== "message" || kept.has(e.id) || (only && !only(e.id))) {
				if (e.type === "message") cur = undefined;
				continue;
			}
			const m = e.message;
			if (m.role === "user") {
				cur = undefined;
				steps.push({ kind: "request", tag: requestTags.get(m.timestamp), text: `User:\n${textOf(m.content)}` });
			} else if (m.role === "assistant") {
				const parts: string[] = [];
				for (const b of m.content as Block[]) {
					if (b.type === "text" && b.text.trim()) parts.push(`Assistant: ${b.text}`);
					// Earlier recalls only repeat history that is already in the steps.
					if (b.type === "toolCall" && b.name !== "recall") parts.push(`Call ${b.name}: ${JSON.stringify(b.arguments)}`);
				}
				cur = { kind: "step", text: parts.join("\n") };
				steps.push(cur);
			} else if (m.role === "toolResult") {
				if (m.toolName === "recall") continue;
				const tag = stepTagOf(m.content);
				const body = (m.content as Block[]).filter((b) => !(b.type === "text" && /^\[#\d+\]$/.test(b.text.trim()))).map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n");
				if (!cur) {
					cur = { kind: "step", text: "" };
					steps.push(cur);
				}
				if (tag && !cur.tag) cur.tag = tag;
				cur.text += `\nResult of ${m.toolName}${m.isError ? " (error)" : ""}:\n${body}`;
			}
		}
		return steps.filter((s) => s.text.trim());
	}

	function recallModel(ctx: ExtensionContext): any {
		const reg = ctx.modelRegistry;
		if (cfg.recallModel) {
			const [provider, ...rest] = cfg.recallModel.split("/");
			const m = reg.find(provider, rest.join("/"));
			if (m) return m;
		}
		const provider = ctx.model?.provider;
		const haikus = reg.getAvailable().filter((m: any) => m.provider === provider && /haiku/i.test(m.id)).sort((a: any, b: any) => (a.id < b.id ? 1 : -1));
		return haikus[0] ?? ctx.model;
	}

	const RECALL_PROMPT =
		"You look up details in the part of a coding session that was removed from the assistant's context. " +
		"The removed history is given as steps, each labelled with a tag like [#12]. Find the steps that answer the question.\n" +
		'Reply with JSON only, no other text: {"steps": [12, 15], "answer": "..."}\n' +
		"- steps: tags of the steps whose original text answers the question, most relevant first, at most 4. Empty if nothing fits.\n" +
		"- answer: one or two sentences answering the question from those steps. Quote code, values and output exactly. " +
		'If the history does not contain the answer, write "not found". Never guess.';

	pi.registerTool({
		name: "recall",
		label: "Recall",
		description:
			"Look up a detail from history that was compacted out of your context: exact code you wrote or read, an error message, " +
			"command output, or what the user said. A helper searches the removed steps and returns a short answer plus the original " +
			"text of the matching steps. Use it when a handoff lacks a detail you need; it does not replace writing complete handoffs. " +
			"`in` names the compaction that removed the detail: the tag in 'the steps from [#n]' of that compaction's result. " +
			"Only that part is searched, and the rest of the compacted history only if the detail is not there. " +
			"For the current state of files, read the files instead. The recall call and its result are removed automatically after your answer: " +
			"put what you need from it into the answer, and do not compact it yourself.",
		promptSnippet: "recall: look up details from compacted history",
		parameters: Type.Object({
			question: Type.String({ description: "What you need to know, specific enough to find it, e.g. 'the original buggy line in src/total.js'" }),
			in: Type.String({ description: "Start tag of the compaction that removed the detail, e.g. '#20'" }),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const all = removedSteps(ctx);
			if (all.length === 0) return { content: [{ type: "text", text: "Nothing has been compacted out of your context, so there is nothing to recall." }], details: { found: false } };
			const model = recallModel(ctx);
			if (!model) throw new Error("recall: no model available.");
			const label = (s: Step) => (s.tag ? `[#${s.tag}]` : "[untagged]");
			const usages: any[] = [];

			// Code and JSON run near 3 chars per token; keep room for the provider's system prompt and the answer.
			const window = (model as any).contextWindow > 0 ? (model as any).contextWindow : 200_000;
			let budgetTokens = Math.min(cfg.recallMaxInputTokens, Math.floor(window * 0.6));

			const ask = async (steps: Step[]): Promise<{ answer: string; chosen: Step[]; found: boolean; tags: number[] }> => {
				// History for the helper: newest steps first win when the budget is tight.
				const budget = budgetTokens * 3;
				const perStep = Math.max(2_000, Math.floor(budget / steps.length));
				const blocks: string[] = [];
				let used = 0;
				for (const s of [...steps].reverse()) {
					const b = `${label(s)} ${s.kind === "request" ? "(user request)" : ""}\n${clip(s.text, perStep)}`;
					if (used + b.length > budget) break;
					blocks.unshift(b);
					used += b.length;
				}
				const response = await ctx.modelRegistry.complete(
					model,
					{
						systemPrompt: RECALL_PROMPT,
						messages: [{ role: "user", content: [{ type: "text", text: `Removed history:\n\n${blocks.join("\n\n")}\n\nQuestion: ${params.question}` }], timestamp: Date.now() }],
					} as any,
					{ signal, cacheRetention: "none", sessionId: randomUUID() } as any,
				);
				if (response.stopReason === "error" && /too long|context|token/i.test(response.errorMessage ?? "") && budgetTokens > 10_000) {
					budgetTokens = Math.floor(budgetTokens / 2);
					return ask(steps);
				}
				if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(`recall: helper failed (${response.errorMessage ?? response.stopReason}).`);
				usages.push(response.usage);
				const raw = response.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
				let answer = raw.trim();
				let tags: number[] = [];
				try {
					const json = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? "");
					answer = String(json.answer ?? "").trim();
					tags = (Array.isArray(json.steps) ? json.steps : []).map((t: any) => Number(String(t).replace(/\D/g, ""))).filter((t: number) => t > 0);
				} catch {}
				const chosen = tags.map((t) => steps.find((s) => s.tag === t)).filter((s): s is Step => !!s);
				const found = chosen.length > 0 && !/^not found\.?$/i.test(answer);
				log(ctx, { kind: "recall", model: `${model.provider}/${model.id}`, steps: steps.length, inputChars: used, chosen: chosen.map((s) => s.tag), usage: response.usage });
				return { answer, chosen, found, tags };
			};

			// Search the named compaction first, the rest only when the detail is not there.
			let scope = "";
			let result: Awaited<ReturnType<typeof ask>> | undefined;
			const inTag = Number(/\d+/.exec(params.in ?? "")?.[0]);
			{
				const c = inTag > 0 ? compactionFor(ctx, inTag) : undefined;
				const inside = c ? removedSteps(ctx, (id) => c.ids.has(id)) : [];
				if (!c || inside.length === 0) {
					scope = `No compaction found for "${params.in}"; searched all compacted history.`;
				} else {
					result = await ask(inside);
					if (result.found) scope = `Found in the compaction from [#${c.from}].`;
					else {
						const rest = removedSteps(ctx, (id) => !c.ids.has(id));
						scope = `Not in the compaction from [#${c.from}]; searched the rest of the compacted history.`;
						result = rest.length > 0 ? await ask(rest) : result;
						if (rest.length === 0) scope = `Not in the compaction from [#${c.from}], and nothing else was compacted.`;
					}
				}
			}
			result ??= await ask(all);
			const { answer, chosen, tags } = result;
			const usage = usages.reduce(
				(a, u) =>
					u
						? {
								input: a.input + (u.input ?? 0),
								output: a.output + (u.output ?? 0),
								cacheRead: a.cacheRead + (u.cacheRead ?? 0),
								cacheWrite: a.cacheWrite + (u.cacheWrite ?? 0),
								totalTokens: a.totalTokens + (u.totalTokens ?? 0),
								cost: {
									input: a.cost.input + (u.cost?.input ?? 0),
									output: a.cost.output + (u.cost?.output ?? 0),
									cacheRead: a.cost.cacheRead + (u.cost?.cacheRead ?? 0),
									cacheWrite: a.cost.cacheWrite + (u.cost?.cacheWrite ?? 0),
									total: a.cost.total + (u.cost?.total ?? 0),
								},
							}
						: a,
				{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			);

			// Original text of the chosen steps, from the session itself.
			const cap = cfg.recallMaxTokens * 4;
			const originals: string[] = [];
			let left = cap;
			for (const s of chosen) {
				if (left < 200) break;
				const t = clip(s.text, Math.max(200, Math.floor(left / Math.max(1, chosen.length - originals.length))));
				originals.push(`--- ${label(s)}${s.kind === "request" ? " user request" : ""}\n${t}`);
				left -= t.length;
			}
			const found = originals.length > 0 && !/^not found\.?$/i.test(answer);
			let text = `Recall (from compacted history; files may have changed since). This is the original record: answer from it, it needs no further checking. It is removed automatically after your answer.\n${scope ? `${scope}\n` : ""}${answer || "not found"}`;
			if (originals.length > 0) text += `\n\nOriginal text:\n${originals.join("\n\n")}`;
			return { content: [{ type: "text", text }], details: { found, tags, in: params.in, model: `${model.provider}/${model.id}` }, usage } as any;
		},
	});

	// ---- apply compactions, remind ----------------------------------------------------------------

	pi.on("turn_end", async (event, ctx) => {
		const msg: any = event.message;
		if (msg.role !== "assistant") return;
		const drafts: any[] = [];
		for (const b of toolCalls(msg)) {
			if (b.name !== "todos") continue;
			const plan = pending.get(b.id);
			pending.delete(b.id);
			if (!plan) continue;
			if (plan.close) {
				// Pre-end check: the prompt, this call and its result go; the handoff goes in front of the answer.
				for (const id of [plan.close.promptId, event.messageEntryId, ...event.toolResultEntryIds]) drafts.push({ type: "context_edit", targetId: id, replacement: null });
				// Added in the context hook, so the stored answer that pi shows and prints stays unchanged.
				if (plan.close.note) {
					answerNotes.set(plan.close.answerTs, plan.close.note);
					drafts.push({ type: "custom", customType: ANSWER_NOTE_TYPE, data: { ts: plan.close.answerTs, note: plan.close.note } });
				}
				log(ctx, { kind: "end-check", compacted: plan.omit.length > 0, removedTokens: plan.removedTokens, outcome: event.outcome });
				if (plan.omit.length === 0) continue;
			} else if (event.outcome !== "completed") continue;
			for (const id of plan.omit) drafts.push({ type: "context_edit", targetId: id, replacement: null });
			if (cfg.stripCompactThinking && !plan.close) {
				const content = (msg.content as Block[]).filter((c) => c.type !== "thinking" && c.type !== "redacted_thinking");
				if (content.length < msg.content.length) drafts.push({ type: "context_edit", targetId: event.messageEntryId, replacement: { content } });
			}
			stats.compactions++;
			stats.removedTokens += plan.removedTokens;
			log(ctx, { kind: "compact", removedTokens: plan.removedTokens });
		}

		if (cold) {
			for (const id of cold.omit) drafts.push({ type: "context_edit", targetId: id, replacement: null });
			for (const r of cold.results.values()) drafts.push({ type: "context_edit", targetId: r.id, replacement: { content: [{ type: "text", text: r.text }] } });
			stats.compactions += cold.results.size;
			stats.removedTokens += cold.removedTokens;
			cold = undefined;
		}
		if (drafts.length > 0) {
			run.compacted = true;
			lastReminder = 0;
		}
		updateStatus(ctx);
		if (drafts.length > 0) return { entries: drafts };
	});

	// Recall results serve one answer: once it is written, drop the recall steps of this request, so the looked-up
	// text does not stay in every later request. Only steps that contain nothing but recall calls are removed.
	pi.on("tool_call", async (event) => {
		if (run.closing && event.toolName !== "todos") return { block: true, reason: "Your answer is complete. Only todos now.", terminate: true };
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		const entries = projection(ctx);
		const start = lastUserIndex(entries);
		if (start < 0) return;
		const drafts: any[] = [];
		if (run.closing) {
			// The check got a reply instead of a todos call: remove the prompt and everything after it.
			run.closing = false;
			const close = closeCheckOf(entries);
			if (close) for (const e of entries.slice(close.prompt)) drafts.push({ type: "context_edit", targetId: e.sourceEntry.id, replacement: null });
			log(ctx, { kind: "end-check", compacted: false, reply: true });
			return drafts.length > 0 ? { entries: drafts } : undefined;
		}
		for (let i = start + 1; i < entries.length - 1; i++) {
			const m = first(entries[i]);
			const calls = toolCalls(m);
			if (calls.length === 0 || calls.some((b) => b.name !== "recall")) continue;
			if ((m.content as Block[]).some((b) => b.type === "text" && String(b.text).trim())) continue;
			const ids = new Set(calls.map((b) => b.id));
			const results = entries.filter((e) => first(e)?.role === "toolResult" && ids.has(first(e).toolCallId));
			if (results.length !== ids.size) continue;
			for (const e of [entries[i], ...results]) drafts.push({ type: "context_edit", targetId: e.sourceEntry.id, replacement: null });
			log(ctx, { kind: "recall-drop", removedTokens: tokensOf([m, ...results.map(first)]) });
		}

		// Before the request ends: are enough of its steps left uncompacted to be worth a compaction?
		const last = entries.length - 1;
		const answer = first(entries[last]);
		const isAnswer = answer?.role === "assistant" && toolCalls(answer).length === 0 && (answer.content as Block[]).some((b) => b.type === "text" && String(b.text).trim());
		if (cfg.checkBeforeEnd && !run.closeAsked && event.outcome === "completed" && isAnswer && overBudget(ctx)) {
			const dropped = new Set(drafts.map((d) => d.targetId));
			const keep = (e: Projected) => visible(e) && !dropped.has(e.sourceEntry.id);
			const tagOf = (e: Projected) => {
				const m = first(e);
				return m?.role === "user" ? requestTags.get(m.timestamp) : m?.role === "toolResult" ? stepTagOf(m.content) : undefined;
			};
			const isLayer = (e: Projected) => first(e)?.role === "toolResult" && first(e).toolName === "todos" && !!first(e).details?.compacted;
			// This request: steps after its last compaction are not compacted; the ones before are compaction layers.
			let from = start + 1;
			entries.forEach((e, i) => {
				if (i > start && isLayer(e)) from = i + 1;
			});
			const fresh = entries.slice(from, last).filter(keep);
			const freshTokens = tokensOf(fresh.flatMap((e) => e.messages));
			const freshTag = fresh.map(tagOf).find((t) => t !== undefined);
			// Settled: earlier requests (since pi's last own compaction, which a range may not cross) and this request's layers.
			const base = historyStart(entries);
			const earlier = entries.slice(base, start).filter(keep);
			const settled = [...earlier, ...entries.slice(start + 1, from).filter(keep)];
			const settledTokens = tokensOf(settled.flatMap((e) => e.messages));
			// A cut from a tag up to the answer: it has to remove at least minCompactTokens.
			const pays = (i: number) => {
				if (i < 0 || i >= last) return false;
				const span = entries.slice(i, last).filter((x, j) => keep(x) && i + j !== start);
				return tokensOf(span.flatMap((x) => x.messages)) >= cfg.minCompactTokens;
			};
			const startOf = (e: Projected | undefined) => (e ? cutStart(entries, entries.indexOf(e), start) : -1);
			const candidates = [...(earlier.length > 0 ? [{ tag: 0, at: base }] : []), ...settled.filter((e) => tagOf(e) !== undefined).map((e) => ({ tag: tagOf(e)!, at: startOf(e) }))];
			const settledTag = cfg.settledCheckTokens > 0 ? candidates.find((c) => pays(c.at))?.tag : undefined;
			const total = settledTokens + freshTokens;
			const settledDue =
				settledTag !== undefined &&
				total >= cfg.settledCheckTokens &&
				total >= settledKept + cfg.settledCheckTokens;
			const freshDue = freshTag !== undefined && freshTokens >= cfg.minCompactTokens && pays(startOf(fresh.find((e) => tagOf(e) === freshTag)));
			if (settledDue || freshDue) {
				run.closeAsked = true;
				run.closing = true;
				run.closeTotal = total;
				const k = (n: number) => `~${Math.round(n / 100) / 10}k tokens`;
				const parts: string[] = [];
				if (settledDue) {
					const requests = earlier.filter((e) => first(e)?.role === "user").length;
					const layers = settled.filter(isLayer).length;
					const what = [requests > 0 ? `${requests} earlier request(s) with their answers` : "", layers > 0 ? `${layers} compaction handoff(s)` : ""].filter(Boolean).join(", ");
					parts.push(`${k(settledTokens)} of finished conversation from [#${settledTag}]${what ? ` (${what})` : ""}`);
				}
				if (freshTag !== undefined && freshTokens > 0) parts.push(`${k(freshTokens)} of steps in this request from [#${freshTag}] that are not compacted`);
				const suggest = settledDue ? settledTag : freshTag;
				drafts.push({
					type: "custom_message",
					customType: CLOSE_TYPE,
					display: false,
					content:
						`[ristretto] Your answer is complete and the user has it. Still in your context: ${parts.join("; ")}. ` +
						`Call todos now and nothing else: with compact_from "#${suggest}" (or a later tag) and a handoff if you no longer need their raw details. ` +
						`Your handoff replaces earlier handoffs in the range: keep from them, and from the conversation, what still matters, including what the user may refer back to. ` +
						`Or call todos without arguments to keep everything. Your answer stays as written; do not write another one.` +
						(howToFor(ctx) ? `\n\n${HOWTO}` : ""),
				});
				return { entries: drafts, continue: true };
			}
		}
		if (drafts.length > 0) return { entries: drafts };
	});

	// Nudge and reminder ride on a tool result: a separate message reaches Claude Code as a message from the user,
	// which the model rightly distrusts. The guideline names the source of [ristretto] notes.
	function overBudget(ctx: ExtensionContext): boolean {
		return contextTokens(ctx) >= cfg.contextBudgetTokens;
	}

	/**
	 * Context size as the model sees it: the usage of the last response plus estimates for later messages.
	 * After an edit that usage is stale, so the estimate is used, corrected by the gap between usage and
	 * estimate last seen (system prompt, tool definitions, estimate error).
	 */
	function contextTokens(ctx: ExtensionContext): number {
		const entries = projection(ctx);
		const estimate = tokensOf(entries.flatMap((e) => e.messages));
		let i = entries.length - 1;
		while (i >= 0 && !(first(entries[i])?.role === "assistant" && first(entries[i]).usage && first(entries[i]).stopReason !== "error" && first(entries[i]).stopReason !== "aborted")) i--;
		if (i < 0) return estimate + usageGap;
		const branch = ctx.sessionManager.getBranch() as any[];
		const at = branch.findIndex((e) => e.id === entries[i].sourceEntry?.id);
		if (at < 0 || branch.slice(at + 1).some((e) => e.type === "context_edit")) return estimate + usageGap;
		const u = first(entries[i]).usage;
		const upTo = tokensOf(entries.slice(0, i + 1).flatMap((e) => e.messages));
		const real = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0);
		if (real <= 0) return estimate + usageGap;
		usageGap = real - upTo;
		return estimate + usageGap;
	}

	/** The full how-to, when the context is over budget and the how-to is not in it (never sent, or compacted away). */
	function howToFor(ctx: ExtensionContext): string | undefined {
		if (!overBudget(ctx)) return undefined;
		const has = (c: unknown) => (typeof c === "string" ? c.includes(HOWTO_MARK) : Array.isArray(c) && c.some((b: Block) => b.type === "text" && String(b.text).includes(HOWTO_MARK)));
		const shown = projection(ctx).some((e) => e.messages.some((m: any) => m.role !== "assistant" && has(m.content)));
		return shown ? undefined : HOWTO;
	}

	function noteFor(ctx: ExtensionContext): string | undefined {
		const notes = [howToFor(ctx), dueNote(ctx)].filter(Boolean);
		return notes.length > 0 ? notes.join("\n\n") : undefined;
	}

	function dueNote(ctx: ExtensionContext): string | undefined {
		const entries = projection(ctx);
		const total = contextTokens(ctx);
		if (total < cfg.contextBudgetTokens) return undefined;
		const work = total - run.startTokens;
		if (cfg.nudgeUncompactedTokens > 0 && !run.compacted && !run.nudged && work >= cfg.nudgeUncompactedTokens) {
			run.nudged = true;
			const current = [...state.todos].sort(byNumber).reverse().find((t) => t.status === "in_progress");
			if (current?.since) {
				return `[ristretto] ~${Math.round(work / 1000)}k tokens of steps in this request are not compacted. As soon as task ${current.id} is done, mark it completed and compact from #${tagView(ctx)(current.since)} in the same todos call, before you start the next task.`;
			}
			if (untrackedFrom !== undefined && state.todos.filter(isOpen).length > 1) {
				return `[ristretto] ~${Math.round(work / 1000)}k tokens of steps in this request are not compacted. As soon as the task you are on is done, mark it completed and compact its steps (from #${tagView(ctx)(untrackedFrom)}) in the same todos call, before you start the next task.`;
			}
			return `[ristretto] ~${Math.round(work / 1000)}k tokens of steps in this request are not compacted. When they are finished, compact them with todos (compact_from + handoff; tasks are optional) before you answer.`;
		}
		if (cfg.reminderEveryTokens > 0) {
			let from = 0;
			entries.forEach((e, i) => {
				const m = first(e);
				if (m?.role === "toolResult" && m.toolName === "todos" && m.details?.compacted) from = i + 1;
			});
			const since = tokensOf(entries.slice(from).flatMap((e) => e.messages));
			if (since < lastReminder) lastReminder = 0;
			if (since >= cfg.reminderEveryTokens && since >= lastReminder + cfg.reminderEveryTokens) {
				lastReminder = since;
				return `[ristretto] ~${Math.round(since / 1000)}k tokens since the last compaction. Update your tasks, and compact what is finished.`;
			}
		}
		return undefined;
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const tokens = contextTokens(ctx);
		ctx.ui.setStatus("ristretto", `context ~${Math.round(tokens / 1000)}k`);
	}

	// Compactions held back as too small, once the prompt cache has expired: removing them now costs nothing,
	// since the next request writes the whole context to the cache anyway. No model call.
	const coldCuts = (ctx: ExtensionContext) => {
		const entries = projection(ctx);
		const lastAt = [...entries].reverse().map(first).find((m) => m?.role === "assistant")?.timestamp;
		const ttl = cfg.cacheLifetime === "5m" ? 5 * 60_000 : 60 * 60_000;
		if (typeof lastAt !== "number" || Date.now() - lastAt <= ttl) return undefined;
		const live = new Set(entries.filter(visible).map((e) => e.sourceEntry.id));
		const omit = new Set<string>();
		const keys = new Set<string>();
		const results = new Map<string, { id: string; text: string }>();
		let removedTokens = 0;
		// Latest first: a held-back cut whose call lies in a later one is skipped, since the later handoff
		// does not cover its steps.
		for (const e of [...entries].reverse()) {
			if (!visible(e) || omit.has(e.sourceEntry.id)) continue;
			const m = first(e);
			const d: Deferred | undefined = m.role === "toolResult" && m.toolName === "todos" ? m.details?.deferred : undefined;
			if (!d || !d.omit.every((id) => live.has(id))) continue;
			for (const id of d.omit) omit.add(id);
			for (const k of d.keys) keys.add(k);
			results.set(m.toolCallId, { id: e.sourceEntry.id, text: d.text });
			removedTokens += d.removedTokens;
		}
		return results.size > 0 ? { omit: [...omit], keys, results, removedTokens } : undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		cfg = loadConfig();
		pending.clear();
		cold = undefined;
		restore(ctx);
		updateWidget(ctx);
		updateStatus(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		restore(ctx);
		updateWidget(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// messageType exists since pi 1.2; older versions only start runs from user prompts.
		if ((event as { messageType?: string }).messageType === "custom") return;
		archiveFinished(ctx);
		cold = coldCuts(ctx);
		if (cold) log(ctx, { kind: "cold-cut", removedTokens: cold.removedTokens, cuts: cold.results.size });
		untrackedFrom = undefined;
		run = { startTokens: contextTokens(ctx), compacted: false, nudged: false, closeAsked: false, closing: false, closeTotal: 0 };
	});

	pi.registerCommand("todos", {
		description: "Show the full task list: open tasks, finished ones, earlier requests and rules",
		handler: async (_args, ctx) => showFullList(ctx),
	});

	// ---- commands --------------------------------------------------------------------------------

	pi.registerCommand("ristretto-stats", {
		description: "Show ristretto activity and cache usage for this session",
		handler: async (_args, ctx) => {
			const all = stats.cacheRead + stats.cacheWrite + stats.input;
			ctx.ui.notify(
				[
					`requests ${stats.requests}, cache hit ${all > 0 ? ((stats.cacheRead / all) * 100).toFixed(1) : "0"}%`,
					`input ${stats.input}, cacheRead ${stats.cacheRead}, cacheWrite ${stats.cacheWrite}, output ${stats.output}`,
					`API-equivalent cost $${stats.cost.toFixed(3)}`,
					`compactions ${stats.compactions}, ~${stats.removedTokens} tokens removed`,
					`log: ${LOG_FILE}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("ristretto-config", {
		description: "Show or set ristretto options: /ristretto-config [key value]",
		handler: async (args, ctx) => {
			const [key, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (key) {
				if (!(key in DEFAULTS)) return ctx.ui.notify(`Unknown option ${key}`, "error");
				const raw = rest.join(" ");
				const def = (DEFAULTS as any)[key];
				const value = typeof def === "number" ? Number(raw) : typeof def === "boolean" ? raw === "true" : raw;
				if (typeof def === "number" && !Number.isFinite(value)) return ctx.ui.notify(`${key} needs a number`, "error");
				if (key === "todoPanel" && !PANEL_MODES.includes(value as string)) return ctx.ui.notify(`todoPanel: one of ${PANEL_MODES.join(", ")}`, "error");
				if (key === "cacheLifetime" && value !== "5m" && value !== "1h") return ctx.ui.notify("cacheLifetime: 5m or 1h", "error");
				(cfg as any)[key] = value;
				saveConfig(cfg);
				if (key.startsWith("todoPanel") || key.startsWith("side")) {
					if (panel) ctx.ui.setWidget(PANEL_KEY, undefined);
					panel = undefined;
					updateWidget(ctx);
				}
			}
			ctx.ui.notify(Object.entries(cfg).map(([k, v]) => `${k}: ${v}`).join("\n"), "info");
		},
	});
}
