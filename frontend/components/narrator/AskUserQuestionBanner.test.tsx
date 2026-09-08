import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { HumanAttentionItem } from "@shared/human-attention";
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
} from "../../hooks/useAsyncQuestions";
import { humanAttentionListKey } from "../../hooks/useHumanAttention";
import { api } from "../../lib/api";
import {
	flush,
	readSession,
	resetSessionStoreForTest,
	writeSession,
} from "../../lib/session-store";
import { AskUserQuestionBanner } from "./AskUserQuestionBanner";
import {
	AsyncQuestionInboxButton,
	AsyncQuestionInboxDrawer,
	type GlobalQuestion,
} from "./GlobalQuestionInbox";

const { buildAsyncQuestionNode } = await import("./vlist/vlist-permission-bridge");

const questions = [{ question: "notes", header: "Notes?", options: [] }];
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

test("the real inbox appears for a quiet open, updates urgency, and disappears after inline decisions", async () => {
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
						question: "targets",
						header: "Targets?",
						multiSelect: true,
						options: [
							{ label: "web", description: "" },
							{ label: "api", description: "" },
						],
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
