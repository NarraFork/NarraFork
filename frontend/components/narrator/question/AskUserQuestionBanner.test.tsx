import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { HumanAttentionItem } from "@shared/human-attention";
import { adaptSegment } from "@shared/pretext-layout/segment-adapter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import {
	useAnswerAsyncQuestion,
	useApplyAsyncQuestionChange,
	useAsyncQuestions,
	useDismissAsyncQuestion,
} from "../../../hooks/useAsyncQuestions";
import { humanAttentionListKey } from "../../../hooks/useHumanAttention";
import { api } from "../../../lib/api";
import { ApiError } from "../../../lib/api/client";
import {
	flush,
	readSession,
	resetSessionStoreForTest,
	writeSession,
} from "../../../lib/session-store";
import { installCanvasStub } from "../vlist/measure/test-canvas-stub";
import { QuestionEventAction } from "../vlist/QuestionEventAction";
import { VLIST_REGISTRY } from "../vlist/registry";
import { renderElement, resolveRenderExtra } from "../vlist/render-registry";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import { type AsyncQuestionAnswerSnapshot, AsyncQuestionDetail } from "./AsyncQuestionDetail";
import {
	AsyncQuestionInboxButton,
	AsyncQuestionInboxDrawer,
	type GlobalQuestion,
} from "./GlobalQuestionInbox";

const { buildAsyncQuestionNode } = await import("../vlist/vlist-permission-bridge");

const questions = [{ id: "notes", header: "Notes?", options: [] }];
const deferredQuestion: GlobalQuestion = {
	id: "async-record-id",
	narratorId: "n1",
	narratorTitle: "Session",
	chapterId: null,
	toolCallId: "original-permission-id",
	toolUseId: "tool-use-id",
	questions,
	answers: null,
	status: "open",
	origin: "user_deferred",
	answerMessageId: null,
	decidedBy: null,
	decidedAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
};
function attentionItem(question: GlobalQuestion): HumanAttentionItem {
	return {
		id: `question:${question.id}`,
		kind: "async_question",
		source: "question",
		requestId: question.id,
		toolCallId: question.toolCallId,
		toolName: "AskUserQuestion",
		narratorId: question.narratorId,
		narratorTitle: question.narratorTitle,
		parentNarratorId: null,
		rootNarratorId: null,
		chapterId: question.chapterId,
		createdAt: question.createdAt,
		blocking: question.awaited === true,
		canAct: true,
		summary: question.questions[0]?.header ?? "",
	};
}
const draft = JSON.stringify({
	selections: {},
	customInputs: { notes: "Keep this unfinished answer" },
});
const i18n = createInstance();
await i18n.init({ lng: "en", resources: {}, fallbackLng: "en", initImmediate: false });
let restoreGlobals: () => void;
let qc: QueryClient;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "fonts", {
		configurable: true,
		value: { addEventListener() {}, removeEventListener() {} },
	});
	const values = new Map<string, string>();
	const sessionStorage = {
		get length() {
			return values.size;
		},
		key: (index: number) => [...values.keys()][index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
		clear: () => values.clear(),
	};
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		ShadowRoot: window.ShadowRoot,
		sessionStorage,
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		}),
		getComputedStyle: () => ({ getPropertyValue: () => "", boxSizing: "border-box" }),
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(cb, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const descriptors = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	for (const [key, value] of Object.entries(globals))
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	restoreGlobals = () => {
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	resetSessionStoreForTest();
	qc = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false }, mutations: { retry: false } },
	});
	qc.setQueryData(["settings"], { agent: {} });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	qc.clear();
	container.remove();
	resetSessionStoreForTest();
	restoreGlobals();
});

async function render(node: ReactNode) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">{node}</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
}

function button(label: string) {
	const found = [...document.querySelectorAll("button")].find((item) =>
		item.textContent?.includes(label),
	);
	expect(found).toBeDefined();
	return found as HTMLButtonElement;
}

test("async read-only detail maps colliding headers by canonical question ID", async () => {
	const detail = spyOn(api, "getAsyncQuestionDetail").mockResolvedValue({
		question: {
			...deferredQuestion,
			status: "answered",
			questions: [
				{ id: "q1", header: "q2", options: [] },
				{ id: "q2", header: "Second question", options: [] },
			],
			answers: { q1: "First canonical answer", q2: "Second canonical answer" },
		},
		supplements: [],
		nextCursor: null,
		canAct: false,
	});
	try {
		await render(<AsyncQuestionDetail narratorId="n1" questionId={deferredQuestion.id} />);
		for (let n = 0; n < 3; n++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		expect(container.textContent).toContain("First canonical answer");
		expect(container.textContent?.split("Second canonical answer")).toHaveLength(2);
		expect(container.querySelector("textarea")).toBeNull();
	} finally {
		detail.mockRestore();
	}
});

test("async submission uses frozen IDs and preserves its draft until successful retry", async () => {
	writeSession("ask-draft", "stable-call", draft);
	let failed = true;
	const submissions: Record<string, string>[] = [];
	await render(
		<AskUserQuestionBanner
			requestId="record"
			draftId="stable-call"
			answerKey="id"
			questions={questions}
			onSubmit={async (_id, answers) => {
				submissions.push(answers);
				if (failed) throw new Error("submission offline");
			}}
		/>,
	);
	await act(async () => button("submitAnswer").click());
	expect(submissions).toEqual([{ notes: "Keep this unfinished answer" }]);
	expect(readSession("ask-draft", "stable-call")).not.toBeNull();
	expect(container.textContent).toContain("submission offline");
	failed = false;
	await act(async () => button("submitAnswer").click());
	expect(readSession("ask-draft", "stable-call")).toBeNull();
});

test("question detail preserves supplement draft and original answer on failure, then links retry to the current event", async () => {
	const question = {
		...deferredQuestion,
		status: "answered" as const,
		answers: { notes: "Original answer" },
		answerMessageId: "answer-1",
		resolution: null,
	};
	const detail = spyOn(api, "getAsyncQuestionDetail").mockResolvedValue({
		question,
		supplements: [],
		nextCursor: null,
	});
	const supplement = spyOn(api, "supplementAsyncQuestion").mockRejectedValue(
		new Error("supplement offline"),
	);
	writeSession("ask-draft", `supplement:${question.id}`, "Corrected answer");
	try {
		await render(<AsyncQuestionDetail narratorId="n1" questionId={question.id} />);
		for (let n = 0; n < 3; n++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		await act(async () => button("asyncQuestionSendSupplement").click());
		for (let n = 0; n < 3; n++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		expect(readSession("ask-draft", `supplement:${question.id}`)).toBe("Corrected answer");
		expect(container.textContent).toContain("Original answer");
		expect(container.textContent).toContain("supplement offline");
		supplement.mockResolvedValue({
			ok: true,
			question: { ...question, answerMessageId: "supplement-2" },
		});
		await act(async () => button("asyncQuestionSendSupplement").click());
		for (let n = 0; n < 3; n++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		expect(supplement).toHaveBeenCalledWith("n1", question.id, {
			text: "Corrected answer",
			answerMessageId: "answer-1",
		});
		expect(readSession("ask-draft", `supplement:${question.id}`)).toBeNull();
	} finally {
		detail.mockRestore();
		supplement.mockRestore();
	}
});

test("read-only question detail retains context and answers without answer or supplement actions", async () => {
	const detail = spyOn(api, "getAsyncQuestionDetail").mockResolvedValue({
		question: {
			...deferredQuestion,
			status: "answered",
			context: "Frozen task context",
			answers: { notes: "Visible answer" },
		},
		supplements: [],
		nextCursor: null,
		canAct: false,
	});
	try {
		await render(<AsyncQuestionDetail narratorId="n1" questionId={deferredQuestion.id} />);
		for (let n = 0; n < 3; n++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		expect(container.textContent).toContain("Frozen task context");
		expect(container.textContent).toContain("Visible answer");
		expect(
			[...container.querySelectorAll("button")].some(
				(item) =>
					item.textContent?.includes("submitAnswer") ||
					item.textContent?.includes("asyncQuestionSendSupplement"),
			),
		).toBe(false);
	} finally {
		detail.mockRestore();
	}
});

test("fork answer event stays frozen after original actor supplements, even when its live API would succeed", async () => {
	const snapshot: AsyncQuestionAnswerSnapshot = {
		kind: "asyncQuestionAnswers",
		questionId: "original-q",
		createdAt: "2026-01-01",
		context: "Frozen fork context",
		outcome: "answered",
		supplement: "Frozen correction",
		items: [
			{
				questionId: "choice",
				header: "Frozen choice",
				answer: "Frozen answer",
				notes: "Frozen notes",
				options: [{ header: "Original option", description: "Original meaning" }],
			},
		],
	};
	// The original actor answered before fork. Its record keeps evolving after the frozen event.
	const currentQuestion = {
		...deferredQuestion,
		id: snapshot.questionId as string,
		narratorId: "original",
		context: snapshot.context,
		status: "answered" as const,
		answers: { notes: "Frozen answer" },
		resolution: {
			answerMessageId: "original-answer",
			note: "Processed after fork",
			resolvedAt: "2026-01-03",
			actor: "original",
		},
	};
	const detail = spyOn(api, "getAsyncQuestionDetail").mockResolvedValue({
		question: currentQuestion,
		supplements: [
			{ messageId: "future-supplement", createdAt: "2026-01-02", text: "New original supplement" },
		],
		nextCursor: null,
		canAct: true,
	});
	const answer = spyOn(api, "answerAsyncQuestion");
	const dismiss = spyOn(api, "dismissAsyncQuestion");
	const supplement = spyOn(api, "supplementAsyncQuestion");
	const restoreCanvas = installCanvasStub();
	writeSession("ask-draft", "supplement:original-q", "Original owner's future draft");
	try {
		const spec = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "inherited-answer",
					role: "user",
					origin: "user",
					narratorId: "original",
					contentJson: [
						{ type: "system_injection", source: "async_question_answer", body: snapshot },
					],
				},
			},
			{ lod: 5 },
		)[0];
		if (!spec) throw new Error("Missing answer event");
		const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 600, 5, spec.opts);
		await render(
			renderElement(spec.kind, measured, { ...resolveRenderExtra(spec), narratorId: "fork" }),
		);
		expect(container.textContent).not.toContain("Frozen answer");
		expect(container.textContent).not.toContain("Frozen fork context");
		await act(async () => button("asyncQuestionDetails").click());
		for (let n = 0; n < 3; n++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		const historical = document.querySelector('[data-question-historical-snapshot="original-q"]');
		expect(historical).not.toBeNull();
		for (const text of [
			"Frozen fork context",
			"Frozen choice",
			"Original option",
			"Original meaning",
			"Frozen answer",
			"Frozen notes",
			"Frozen correction",
		])
			expect(historical?.textContent).toContain(text);
		expect(detail).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain("New original supplement");
		expect(document.body.textContent).not.toContain("Processed after fork");
		expect(document.querySelector("[data-question-detail] textarea")).toBeNull();
		expect(
			[...document.querySelectorAll("button")].some((item) =>
				item.textContent?.includes("asyncQuestionSendSupplement"),
			),
		).toBe(false);
		expect(historical?.querySelector("textarea, button")).toBeNull();
		expect(answer).not.toHaveBeenCalled();
		expect(dismiss).not.toHaveBeenCalled();
		expect(supplement).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain("Original owner's future draft");
		expect(readSession("ask-draft", "supplement:original-q")).toBe("Original owner's future draft");
	} finally {
		detail.mockRestore();
		answer.mockRestore();
		dismiss.mockRestore();
		supplement.mockRestore();
		restoreCanvas();
	}
});

test("an event without a viewing identity fails closed to its frozen body without live API access", async () => {
	const detail = spyOn(api, "getAsyncQuestionDetail");
	try {
		await render(
			<QuestionEventAction
				reference={{ narratorId: "original", questionId: "q1" }}
				snapshot={{
					kind: "asyncQuestionAnswers",
					questionId: "q1",
					context: "Frozen preview context",
					outcome: "answered",
					items: [{ header: "Preview question", answer: "Frozen preview answer" }],
				}}
			/>,
		);
		await act(async () => button("asyncQuestionDetails").click());
		expect(document.body.textContent).toContain("Frozen preview answer");
		expect(document.querySelector("[data-question-historical-snapshot] textarea")).toBeNull();
		expect(detail).not.toHaveBeenCalled();
	} finally {
		detail.mockRestore();
	}
});

test("the original actor's answer event still opens live details and can submit a supplement", async () => {
	const snapshot: AsyncQuestionAnswerSnapshot = {
		kind: "asyncQuestionAnswers",
		questionId: deferredQuestion.id,
		context: "Receipt context",
		outcome: "answered",
		items: [{ header: "Receipt question", answer: "Receipt answer" }],
	};
	const detail = spyOn(api, "getAsyncQuestionDetail").mockResolvedValue({
		question: {
			...deferredQuestion,
			status: "answered",
			answers: { notes: "Authorized current answer" },
		},
		supplements: [],
		nextCursor: null,
		canAct: true,
	});
	const supplement = spyOn(api, "supplementAsyncQuestion").mockResolvedValue({
		ok: true,
		question: { ...deferredQuestion, status: "answered" },
	});
	const restoreCanvas = installCanvasStub();
	writeSession("ask-draft", `supplement:${deferredQuestion.id}`, "Own new supplement");
	try {
		const spec = adaptSegment(
			{
				kind: "message",
				msg: {
					id: "own-answer",
					role: "user",
					origin: "user",
					narratorId: "n1",
					contentJson: [
						{ type: "system_injection", source: "async_question_answer", body: snapshot },
					],
				},
			},
			{ lod: 5 },
		)[0];
		if (!spec) throw new Error("Missing own answer event");
		const measured = VLIST_REGISTRY[spec.kind].measure(spec.data, 600, 5, spec.opts);
		await render(
			renderElement(spec.kind, measured, { ...resolveRenderExtra(spec), narratorId: "n1" }),
		);
		await act(async () => button("asyncQuestionDetails").click());
		for (let n = 0; n < 3; n++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		expect(document.body.textContent).toContain("Authorized current answer");
		expect(document.body.textContent).not.toContain("Receipt answer");
		expect(document.querySelector("[data-question-historical-snapshot]")).toBeNull();
		expect(detail).toHaveBeenCalledWith("n1", deferredQuestion.id, undefined);
		await act(async () => button("asyncQuestionSendSupplement").click());
		expect(supplement).toHaveBeenCalledWith("n1", deferredQuestion.id, {
			text: "Own new supplement",
		});
		expect(readSession("ask-draft", `supplement:${deferredQuestion.id}`)).toBeNull();
	} finally {
		detail.mockRestore();
		supplement.mockRestore();
		restoreCanvas();
	}
});

test("an own event whose live detail is deleted falls back to its read-only receipt", async () => {
	const snapshot: AsyncQuestionAnswerSnapshot = {
		kind: "asyncQuestionAnswers",
		questionId: deferredQuestion.id,
		context: "Deleted context",
		outcome: "answered",
		items: [{ header: "Deleted question", answer: "Historical answer" }],
	};
	const detail = spyOn(api, "getAsyncQuestionDetail").mockRejectedValue(
		new ApiError("Question deleted", 404),
	);
	try {
		await render(
			<AsyncQuestionDetail narratorId="n1" questionId={deferredQuestion.id} snapshot={snapshot} />,
		);
		for (let n = 0; n < 3; n++)
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		const historical = document.querySelector("[data-question-historical-snapshot]");
		expect(historical?.textContent).toContain("Deleted context");
		expect(historical?.textContent).toContain("Historical answer");
		expect(historical?.querySelector("textarea, button")).toBeNull();
		expect(detail).toHaveBeenCalledTimes(1);
	} finally {
		detail.mockRestore();
	}
});

test("the real inbox updates live urgency and returns to a neutral archive entry after inline decisions", async () => {
	let items: GlobalQuestion[] = [];
	const globalList = spyOn(api, "getHumanAttention").mockImplementation(async () => ({
		items: items.map(attentionItem),
		nextCursor: null,
	}));
	const narratorList = spyOn(api, "getAsyncQuestions").mockImplementation(async () => ({
		items,
		nextCursor: null,
		openCount: items.length,
	}));
	const answer = spyOn(api, "answerAsyncQuestion").mockImplementation(async () => {
		items = [];
		return { ok: true, question: { ...deferredQuestion, status: "answered" } };
	});
	const dismiss = spyOn(api, "dismissAsyncQuestion").mockImplementation(async () => {
		items = [];
		return { ok: true, question: { ...deferredQuestion, status: "dismissed" } };
	});
	let apply: ReturnType<typeof useApplyAsyncQuestionChange>;
	let answerMutation: ReturnType<typeof useAnswerAsyncQuestion>;
	let dismissMutation: ReturnType<typeof useDismissAsyncQuestion>;
	function Harness() {
		apply = useApplyAsyncQuestionChange("n1");
		answerMutation = useAnswerAsyncQuestion("n1");
		dismissMutation = useDismissAsyncQuestion("n1");
		useAsyncQuestions("n1");
		return <AsyncQuestionInboxButton currentNarratorId="n1" />;
	}
	const settle = async () => {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	};
	const entry = () => document.querySelector('button[aria-label="humanAttentionOpen"]');
	try {
		await render(<Harness />);
		await settle();
		expect(entry()).toBeNull();
		expect(document.querySelector('button[aria-label="humanAttentionTitle"]')).not.toBeNull();
		for (const decision of ["answered", "dismissed", "withdrawn"] as const) {
			items = [deferredQuestion];
			await act(async () => apply("opened", deferredQuestion));
			await settle();
			expect(entry()).not.toBeNull();
			expect(entry()?.textContent).not.toContain("inboxBadgeAwaitedSuffix");
			for (const change of ["awaited", "await_ended"] as const) {
				items = [{ ...deferredQuestion, awaited: change === "awaited" }];
				await act(async () => apply(change, items[0]));
				await settle();
				expect(entry()?.textContent?.includes("inboxBadgeAwaitedSuffix")).toBe(
					change === "awaited",
				);
			}
			await act(async () => {
				if (decision === "answered")
					await answerMutation.mutateAsync({
						questionId: deferredQuestion.id,
						answers: { notes: "Done" },
					});
				else if (decision === "dismissed")
					await dismissMutation.mutateAsync({ questionId: deferredQuestion.id });
				else {
					items = [];
					apply("withdrawn", { ...deferredQuestion, status: "withdrawn" });
				}
			});
			await settle();
			expect(entry()).toBeNull();
			expect(document.querySelector('button[aria-label="humanAttentionTitle"]')).not.toBeNull();
			expect(qc.getQueryData(["async-questions", "n1"])).toMatchObject({ items: [], openCount: 0 });
			expect(qc.getQueryData(humanAttentionListKey)).toMatchObject({ pages: [{ items: [] }] });
		}
	} finally {
		globalList.mockRestore();
		narratorList.mockRestore();
		answer.mockRestore();
		dismiss.mockRestore();
	}
});

describe("AskUserQuestion draft identity", () => {
	test("defer, unmount, then open the real inbox without losing the permission draft", async () => {
		writeSession("ask-draft", deferredQuestion.toolCallId, draft);
		flush();
		const deferred: string[] = [];
		await render(
			<AskUserQuestionBanner
				requestId={deferredQuestion.toolCallId}
				questions={questions}
				onDefer={(id) => {
					deferred.push(id);
				}}
			/>,
		);
		expect(document.querySelector("textarea")?.value).toBe("Keep this unfinished answer");
		await act(async () => button("deferQuestion").click());
		expect(deferred).toEqual([deferredQuestion.toolCallId]);
		await render(null);
		flush();
		// A page lifecycle loses in-memory state but keeps sessionStorage.
		resetSessionStoreForTest();
		const list = spyOn(api, "getHumanAttention").mockResolvedValue({
			items: [attentionItem(deferredQuestion)],
			nextCursor: null,
		});
		const detail = spyOn(api, "getHumanAttentionDetail").mockResolvedValue({
			item: attentionItem(deferredQuestion),
			question: deferredQuestion,
		});
		const answer = spyOn(api, "answerAsyncQuestion").mockResolvedValue({
			ok: true,
			question: { ...deferredQuestion, status: "answered" },
		});
		try {
			await render(<AsyncQuestionInboxDrawer opened onClose={() => {}} currentNarratorId="n1" />);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			await act(async () => button("humanAttentionReview").click());
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(document.querySelector("textarea")?.value).toBe("Keep this unfinished answer");
			list.mockResolvedValue({ items: [], nextCursor: null });
			await act(async () => button("submitAnswer").click());
			for (let n = 0; n < 3; n++) {
				await act(async () => {
					await new Promise((resolve) => setTimeout(resolve, 0));
				});
			}
			expect(answer).toHaveBeenCalledWith("n1", deferredQuestion.id, {
				// Async answers use frozen question IDs, independent of display headers.
				answers: { notes: "Keep this unfinished answer" },
			});
			expect(readSession("ask-draft", deferredQuestion.toolCallId)).toBeNull();
		} finally {
			answer.mockRestore();
			list.mockRestore();
			detail.mockRestore();
		}
	});

	test("the inline slot uses the same draft identity and submits its own async record id", async () => {
		writeSession("ask-draft", deferredQuestion.toolCallId, draft);
		const submitted: string[] = [];
		await render(
			buildAsyncQuestionNode({
				id: deferredQuestion.id,
				draftId: deferredQuestion.toolCallId,
				questions,
				onSubmit: (id) => {
					submitted.push(id);
				},
				onDismiss: () => {},
			}),
		);
		expect(document.querySelector("textarea")?.value).toBe("Keep this unfinished answer");
		await act(async () => button("submitAnswer").click());
		expect(submitted).toEqual([deferredQuestion.id]);
	});

	test("adopts a legacy async-id draft and removes it on dismissal", async () => {
		writeSession("ask-draft", deferredQuestion.id, draft);
		const dismissed: string[] = [];
		await render(
			<AskUserQuestionBanner
				requestId={deferredQuestion.id}
				draftId={deferredQuestion.toolCallId}
				questions={questions}
				onDeny={(id) => {
					dismissed.push(id);
				}}
			/>,
		);
		expect(document.querySelector("textarea")?.value).toBe("Keep this unfinished answer");
		expect(readSession("ask-draft", deferredQuestion.toolCallId)).toBe(draft);
		expect(readSession("ask-draft", deferredQuestion.id)).toBeNull();
		await act(async () => button("skipQuestion").click());
		expect(dismissed).toEqual([deferredQuestion.id]);
		expect(readSession("ask-draft", deferredQuestion.toolCallId)).toBeNull();
	});

	test("restores multi-select checkboxes as well as free-form text", async () => {
		writeSession(
			"ask-draft",
			"multi-draft",
			JSON.stringify({ selections: { targets: "web, api" }, customInputs: {} }),
		);
		await render(
			<AskUserQuestionBanner
				requestId="new-api-id"
				draftId="multi-draft"
				questions={[
					{
						id: "targets",
						header: "Targets?",
						multiSelect: true,
						options: [{ header: "web" }, { header: "api" }],
					},
				]}
			/>,
		);
		const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
		expect(inputs).toHaveLength(2);
		expect(inputs.every((input) => input.checked)).toBe(true);
	});

	test("callers without an explicit draft identity still restore request-id drafts", async () => {
		writeSession("ask-draft", "legacy-request", draft);
		await render(<AskUserQuestionBanner requestId="legacy-request" questions={questions} />);
		expect(document.querySelector("textarea")?.value).toBe("Keep this unfinished answer");
	});
});
