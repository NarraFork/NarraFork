/**
 * Cache reconciliation for pushed async-question changes.
 *
 * The classification is the whole logic and the easy mistake is subtle: `awaited` /
 * `await_ended` are NOT decisions — the question stays open and merely changes urgency —
 * so treating them like `answered` would drop a question from the inbox at the exact
 * moment an agent started waiting for it.
 *
 * The reducer is imported, not reproduced: a local copy would keep passing while the
 * real one drifted, which is the opposite of what this file is for.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../lib/api";
import { clearFaviconAlert } from "../lib/favicon";
import { narratorWSManager } from "../lib/narrator-ws-manager";
import { updateAsyncQuestionAttention } from "../lib/notification";
import type { AsyncQuestion } from "../types/narrator";
import {
	applyAsyncQuestionChangeToList,
	asyncQuestionsQueryKey,
	useAnswerAsyncQuestion,
	useApplyAsyncQuestionChange,
	useDismissAsyncQuestion,
} from "./useAsyncQuestions";
import { type NarratorListWSEvent, useNarratorsListWS } from "./useNarratorWS";
import { useRecentTabsWS } from "./useRecentTabsWS";

const q = (id: string, overrides: Partial<AsyncQuestion> = {}): AsyncQuestion => ({
	id,
	narratorId: "n1",
	toolCallId: `call-${id}`,
	toolUseId: `tu-${id}`,
	questions: [{ question: "k", header: "h" }],
	answers: null,
	status: "open",
	origin: "agent_async",
	answerMessageId: null,
	decidedBy: null,
	decidedAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	...overrides,
});

const globalKey = ["async-questions", "all"];
const page = (items: AsyncQuestion[]) => ({ items, nextCursor: null, openCount: items.length });

async function withHook<T>(
	useHook: () => T,
	check: (hook: () => T, qc: QueryClient) => Promise<void>,
) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(globals)) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	const container = document.createElement("div");
	const root = createRoot(container);
	let current: T;
	function Harness() {
		current = useHook();
		return null;
	}
	try {
		await act(async () =>
			root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness))),
		);
		await check(() => current, qc);
	} finally {
		// React Query batches observer notifications onto a timer; drain before removing
		// the DOM globals so a settled mutation cannot update React in the next test.
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await act(async () => root.unmount());
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		qc.clear();
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

describe("async-question real hook caches", () => {
	for (const change of [
		"opened",
		"answered",
		"dismissed",
		"withdrawn",
		"awaited",
		"await_ended",
	] as const) {
		it(`${change} reconciles the narrator page and invalidates even a hidden global inbox`, async () => {
			await withHook(
				() => useApplyAsyncQuestionChange("n1"),
				async (hook, qc) => {
					qc.setQueryData(asyncQuestionsQueryKey("n1"), page(change === "opened" ? [] : [q("a")]));
					qc.setQueryData(globalKey, page(change === "opened" ? [] : [q("a")]));
					await act(async () => hook()(change, q("a", { awaited: change === "awaited" })));
					const keep = ["opened", "awaited", "await_ended"].includes(change);
					expect(qc.getQueryData(asyncQuestionsQueryKey("n1"))).toMatchObject({
						openCount: keep ? 1 : 0,
					});
					expect(qc.getQueryState(globalKey)?.isInvalidated).toBe(true);
				},
			);
		});
	}

	for (const decision of ["answer", "dismiss"] as const) {
		it(`inline ${decision} invalidates both pages without waiting for a WS echo`, async () => {
			const apiMethod = decision === "answer" ? "answerAsyncQuestion" : "dismissAsyncQuestion";
			const apiSpy = spyOn(api, apiMethod).mockResolvedValue({
				ok: true,
				question: q("a", { status: "answered" }),
			});
			try {
				await withHook(
					() => ({ answer: useAnswerAsyncQuestion("n1"), dismiss: useDismissAsyncQuestion("n1") }),
					async (hook, qc) => {
						qc.setQueryData(asyncQuestionsQueryKey("n1"), page([q("a")]));
						qc.setQueryData(globalKey, page([q("a")]));
						await act(async () => {
							if (decision === "answer")
								await hook().answer.mutateAsync({ questionId: "a", answers: { k: "yes" } });
							else await hook().dismiss.mutateAsync({ questionId: "a" });
						});
						expect(qc.getQueryState(asyncQuestionsQueryKey("n1"))?.isInvalidated).toBe(true);
						expect(qc.getQueryState(globalKey)?.isInvalidated).toBe(true);
					},
				);
			} finally {
				apiSpy.mockRestore();
			}
		});
	}
});

// dispatchLocalFrame runs the manager's REAL listener filters. Capturing and calling
// a callback directly would miss the omitted event type that caused this regression.
for (const [name, useList] of [
	["narrator list", useNarratorsListWS],
	["recent tabs", useRecentTabsWS],
] as const) {
	describe(`${name} actual async-question subscription`, () => {
		it("terminal frames clear the favicon through the real notification callback", async () => {
			const subscribe = spyOn(narratorWSManager, "subscribe").mockImplementation((ids, opts) => ({
				_id: 1,
				_narratorIds: ids,
				_kind: opts?.kind ?? "list",
			}));
			const unsubscribe = spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {});
			const connection = spyOn(narratorWSManager, "onConnectionChange").mockImplementation(
				() => () => {},
			);
			try {
				await withHook(
					() =>
						useList(["n1"], (id, event) => {
							if (event.type === "awaitedQuestion")
								updateAsyncQuestionAttention(id, event.questionId, event.awaited === true);
						}),
					async () => {
						Object.defineProperty(document, "hasFocus", { configurable: true, value: () => false });
						Object.defineProperty(document, "visibilityState", {
							configurable: true,
							value: "hidden",
						});
						const favicon = document.createElement("link");
						favicon.rel = "icon";
						document.head.appendChild(favicon);
						try {
							for (const change of ["answered", "dismissed", "withdrawn", "await_ended"] as const) {
								await act(async () =>
									narratorWSManager.dispatchLocalFrame({
										type: "async_question_changed",
										narratorId: "n1",
										change: "awaited",
										question: q("a", { awaited: true }),
									}),
								);
								expect(decodeURIComponent(favicon.href)).toContain("#fab005");
								// This is the ONLY terminal frame, just as the server sends it.
								await act(async () =>
									narratorWSManager.dispatchLocalFrame({
										type: "async_question_changed",
										narratorId: "n1",
										change,
										question: q("a", { awaited: false }),
									}),
								);
								expect(favicon.href.startsWith("data:image/svg+xml")).toBe(false);
							}
						} finally {
							clearFaviconAlert();
						}
					},
				);
			} finally {
				subscribe.mockRestore();
				unsubscribe.mockRestore();
				connection.mockRestore();
			}
		});

		for (const change of [
			"opened",
			"answered",
			"dismissed",
			"withdrawn",
			"awaited",
			"await_ended",
		] as const) {
			it(`delivers ${change} to cache reconciliation independently of urgency`, async () => {
				let handleId = 1;
				const subscribe = spyOn(narratorWSManager, "subscribe").mockImplementation((ids, opts) => ({
					_id: handleId++,
					_narratorIds: ids,
					_kind: opts?.kind ?? "list",
				}));
				const unsubscribe = spyOn(narratorWSManager, "unsubscribe").mockImplementation(() => {});
				const connection = spyOn(narratorWSManager, "onConnectionChange").mockImplementation(
					() => () => {},
				);
				const updates: NarratorListWSEvent[] = [];
				try {
					await withHook(
						() => useList(["n1"], (_id, event) => updates.push(event)),
						async (_hook, qc) => {
							qc.setQueryData(globalKey, page([]));
							await act(async () => {
								narratorWSManager.dispatchLocalFrame({
									type: "async_question_changed",
									narratorId: "outside",
									change,
									question: q("outside"),
								});
							});
							expect(qc.getQueryState(globalKey)?.isInvalidated).toBe(false);
							expect(updates).toEqual([]);
							await act(async () => {
								narratorWSManager.dispatchLocalFrame({
									type: "async_question_changed",
									narratorId: "n1",
									change,
									question: q("a", { awaited: change === "awaited" }),
								});
							});
							if (change === "opened") expect(updates).toEqual([]);
							else
								expect(updates).toEqual([
									{ type: "awaitedQuestion", awaited: change === "awaited", questionId: "a" },
								]);
							expect(qc.getQueryState(globalKey)?.isInvalidated).toBe(true);
						},
					);
					updates.length = 0;
					narratorWSManager.dispatchLocalFrame({
						type: "async_question_changed",
						narratorId: "n1",
						change: "awaited",
						question: q("a"),
					});
					expect(updates).toEqual([]);
				} finally {
					subscribe.mockRestore();
					unsubscribe.mockRestore();
					connection.mockRestore();
				}
			});
		}
	});
}

describe("applyAsyncQuestionChangeToList", () => {
	it("removes a question once it is decided", () => {
		const items = [q("a"), q("b")];
		for (const change of ["answered", "dismissed", "withdrawn"] as const) {
			expect(applyAsyncQuestionChangeToList(items, change, q("a")).map((i) => i.id)).toEqual(["b"]);
		}
	});

	it("keeps a question when an agent starts waiting on it", () => {
		const next = applyAsyncQuestionChangeToList([q("a")], "awaited", q("a", { awaited: true }));
		expect(next.map((i) => i.id)).toEqual(["a"]);
		expect(next[0]?.awaited).toBe(true);
	});

	it("keeps it when the wait ends without a decision", () => {
		const next = applyAsyncQuestionChangeToList(
			[q("a", { awaited: true })],
			"await_ended",
			q("a", { awaited: false }),
		);
		expect(next.map((i) => i.id)).toEqual(["a"]);
		expect(next[0]?.awaited).toBe(false);
	});

	it("upserts rather than duplicating on a replayed open event", () => {
		// A reconnect refetches the page AND replays pushed events, so the same question
		// legitimately arrives twice.
		expect(applyAsyncQuestionChangeToList([q("a")], "opened", q("a")).map((i) => i.id)).toEqual([
			"a",
		]);
	});

	it("floats an awaited question above newer unawaited ones", () => {
		const items = [
			q("new", { createdAt: "2026-02-01T00:00:00.000Z" }),
			q("old", { createdAt: "2026-01-01T00:00:00.000Z" }),
		];
		const next = applyAsyncQuestionChangeToList(items, "awaited", q("old", { awaited: true }));
		// An agent is blocked on "old", which makes it the one worth answering first
		// despite being older.
		expect(next.map((i) => i.id)).toEqual(["old", "new"]);
	});

	it("orders unawaited questions newest first", () => {
		const next = applyAsyncQuestionChangeToList(
			[q("old", { createdAt: "2026-01-01T00:00:00.000Z" })],
			"opened",
			q("new", { createdAt: "2026-02-01T00:00:00.000Z" }),
		);
		expect(next.map((i) => i.id)).toEqual(["new", "old"]);
	});
});
