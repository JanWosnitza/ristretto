import assert from "node:assert/strict";
import { test } from "node:test";
import { cutStart, DEFAULTS, isType, removedRequests, renderCompact, renderList, stepTagOf } from "../src/index.ts";

const text = (t: string) => ({ type: "text", text: t });

test("stepTagOf reads only a tag that is its own text block", () => {
	assert.equal(stepTagOf([text("output"), text("[#12]")]), 12);
	assert.equal(stepTagOf([text("see [#3] above")]), undefined);
	assert.equal(stepTagOf("[#5]"), undefined);
});

test("isType accepts the old context-rewind names", () => {
	assert.ok(isType("ristretto-close", "ristretto-close"));
	assert.ok(isType("context-rewind-close", "ristretto-close"));
	assert.ok(!isType("other-close", "ristretto-close"));
});

test("renderList shows open tasks, folds finished ones, lists rules", () => {
	const s = {
		todos: [
			{ id: "1", text: "done task", status: "completed" as const },
			{ id: "1.1", text: "sub", status: "completed" as const },
			{ id: "2", text: "working", status: "in_progress" as const, since: 7 },
			{ id: "3", text: "dropped", status: "cancelled" as const },
		],
		rules: ["no em dashes"],
	};
	assert.equal(renderList(s, 5), "[>] 2 working (since #7)\ndone (1): 1 done task (1/1)\nrules: no em dashes");
});

test("renderCompact shows the task in progress and counts the rest", () => {
	const s = {
		todos: [
			{ id: "1", text: "a", status: "in_progress" as const },
			{ id: "2", text: "b", status: "pending" as const },
		],
		rules: [],
	};
	assert.equal(renderCompact(s, new Set(), false), "[>] 1 a\n1 more open; todos() without arguments lists everything.");
});

test("removedRequests keeps tagged user messages verbatim", () => {
	const msgs = [
		{ role: "user", timestamp: 1, content: "fix the bug, it breaks checkout" },
		{ role: "assistant", timestamp: 2, content: [text("ok")] },
		{ role: "user", timestamp: 3, content: "untagged" },
	];
	const out = removedRequests(msgs, new Map([[1, 4]]));
	assert.match(out, /\[#4\] fix the bug, it breaks checkout$/);
	assert.doesNotMatch(out, /untagged/);
	assert.equal(removedRequests([], new Map()), "");
});

test("cutStart: a step of an earlier request takes the whole request", () => {
	const e = (role: string) => ({ sourceEntry: { type: "message" }, messages: [{ role }] });
	const entries = [e("user"), e("assistant"), e("toolResult"), e("assistant"), e("user"), e("assistant"), e("toolResult")];
	// Tagged result in the current request (starts at 4): cut from its assistant message.
	assert.equal(cutStart(entries, 6, 4), 5);
	// Tagged result in an earlier request: cut from that request's prompt.
	assert.equal(cutStart(entries, 2, 4), 0);
	// A pi compaction is a hard floor.
	const withCompaction = [{ sourceEntry: { type: "compaction" }, messages: [] }, ...entries];
	assert.equal(cutStart(withCompaction, 3, 5), 1);
});
