import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { asyncQuestionsQueryKey } from "@frontend/hooks/useAsyncQuestions";
import { api } from "@frontend/lib/api";
import type { AsyncQuestion } from "@frontend/types/narrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, memo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import narratorEn from "../../locales/en/narrator.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import type { AsyncQuestionSlot } from "./narrator-panel-types";
import { useNarratorAsyncQuestionSlots } from "./useNarratorAsyncQuestionSlots";

const narratorId = "slots-narrator";
const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	initImmediate: false,
	resources: { en: { narrator: narratorEn }, "zh-CN": { narrator: narratorZh } },
});

function question(id = "question-1", overrides: Partial<AsyncQuestion> = {}): AsyncQuestion {
	return {
		id,
		narratorId,
		toolCallId: `call-${id}`,
		toolUseId: `use-${id}`,
		questions: [
			{ question: "Notes?", header: "Notes" },
			{
				question: "Choice?",
				header: "Choice",
				multiSelect: true,
				options: [{ label: "A", preview: "preview" }],
			},
		],
		answers: null,
		status: "open",
		origin: "agent_async",
		answerMessageId: null,
		decidedBy: null,
		decidedAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		awaited: false,
		...overrides,
	};
}

let root: Root;
let client: QueryClient;
let slots: ReadonlyMap<string, AsyncQuestionSlot>;
let consumerRenders: number;
let restoreGlobals: () => void;
let get: ReturnType<typeof spyOn<typeof api, "getAsyncQuestions">>;
let answer: ReturnType<typeof spyOn<typeof api, "answerAsyncQuestion">>;
let dismiss: ReturnType<typeof spyOn<typeof api, "dismissAsyncQuestion">>;

const Consumer = memo(({ value }: { value: ReadonlyMap<string, AsyncQuestionSlot> }) => {
	consumerRenders++;
	return <span>{value.size}</span>;
});

function Probe({ enabled, tick }: { enabled?: boolean; tick: number }) {
	slots = useNarratorAsyncQuestionSlots(narratorId, enabled);
	return (
		<div data-tick={tick}>
			<Consumer value={slots} />
		</div>
	);
}

beforeEach(async () => {
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
	await i18n.changeLanguage("en");
	client = new QueryClient({
		defaultOptions: {
			queries: { staleTime: Infinity, gcTime: Infinity, retry: false },
			mutations: { retry: false },
		},
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	consumerRenders = 0;
	get = spyOn(api, "getAsyncQuestions").mockResolvedValue({
		items: [],
		nextCursor: null,
		openCount: 0,
	});
	answer = spyOn(api, "answerAsyncQuestion").mockResolvedValue({ ok: true, question: question() });
	dismiss = spyOn(api, "dismissAsyncQuestion").mockResolvedValue({
		ok: true,
		question: question(),
	});
});

afterEach(() => {
	act(() => root.unmount());
	client.clear();
	get.mockRestore();
	answer.mockRestore();
	dismiss.mockRestore();
	restoreGlobals();
});

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

async function render(tick = 0, enabled?: boolean) {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<Probe tick={tick} enabled={enabled} />
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
	await settle();
}

async function setQuestions(items: AsyncQuestion[]) {
	await act(async () => {
		client.setQueryData(asyncQuestionsQueryKey(narratorId), {
			items,
			nextCursor: null,
			openCount: items.length,
		});
	});
	await settle();
}

function slot(id = "question-1") {
	const value = slots.get(`use-${id}`);
	if (!value) throw new Error(`Missing slot ${id}`);
	return value;
}

describe("useNarratorAsyncQuestionSlots", () => {
	test("keeps the fallback empty Map and memo consumer stable on unrelated parent renders", async () => {
		await render(0, false);
		const original = slots;
		await render(1, false);
		await render(2, false);
		expect(slots.size).toBe(0);
		expect(slots).toBe(original);
		expect(consumerRenders).toBe(1);
		expect(get).not.toHaveBeenCalled();
	});

	test("fetches by default and keeps a loaded empty Map stable", async () => {
		await render();
		expect(get).toHaveBeenCalledWith(narratorId, { status: "open" });
		const original = slots;
		const renders = consumerRenders;
		await render(1);
		expect(slots).toBe(original);
		expect(consumerRenders).toBe(renders);
	});

	test("replaces the Map on real additions, updates and removals, preserving all slot fields", async () => {
		await setQuestions([]);
		await render();
		const empty = slots;
		await setQuestions([question(), question("hidden", { toolUseId: "" })]);
		expect(slots).not.toBe(empty);
		expect(slots.size).toBe(1);
		expect(slot()).toEqual({
			id: "question-1",
			draftId: "call-question-1",
			questions: [
				{ question: "Notes?", header: "Notes", options: [] },
				{
					question: "Choice?",
					header: "Choice",
					multiSelect: true,
					options: [{ label: "A", description: "", preview: "preview" }],
				},
			],
			busy: false,
			denyLabel: narratorEn.asyncQuestionDismiss,
			awaited: false,
			awaitedLabel: narratorEn.asyncQuestionAwaitedNotice,
			onSubmit: expect.any(Function),
			onDismiss: expect.any(Function),
		});
		const added = slots;
		await render(1);
		expect(slots).toBe(added);
		await setQuestions([
			question("question-1", {
				awaited: true,
				questions: [{ question: "Updated?", header: "Update" }],
			}),
		]);
		expect(slots).not.toBe(added);
		expect(slot().awaited).toBe(true);
		expect(slot().questions[0]?.question).toBe("Updated?");
		const updated = slots;
		await setQuestions([]);
		expect(slots).not.toBe(updated);
		expect(slots.size).toBe(0);
	});

	test("refreshes both labels when the language changes", async () => {
		await setQuestions([question()]);
		await render();
		const original = slots;
		await act(async () => {
			await i18n.changeLanguage("zh-CN");
		});
		expect(slots).not.toBe(original);
		expect(slot().denyLabel).toBe(narratorZh.asyncQuestionDismiss);
		expect(slot().awaitedLabel).toBe(narratorZh.asyncQuestionAwaitedNotice);
		expect(slot().questions).toEqual(original.get("use-question-1")?.questions ?? []);
	});

	for (const action of ["submit", "dismiss"] as const) {
		for (const outcome of ["success", "error"] as const) {
			test(`${action} forwards ids/answers and clears busy on ${outcome}`, async () => {
				await setQuestions([question(), question("question-2")]);
				await render(0, false);
				const deferred =
					Promise.withResolvers<Awaited<ReturnType<typeof api.answerAsyncQuestion>>>();
				const mutation = action === "submit" ? answer : dismiss;
				mutation.mockImplementation(() => deferred.promise);
				const answers = { "Notes?": "Keep this answer" };
				const original = slots;
				// Use the supplied callback id, not the slot's closed-over question id.
				await act(async () => {
					if (action === "submit") slot().onSubmit("question-2", answers);
					else slot().onDismiss("question-2");
				});
				await settle();
				expect(slots).not.toBe(original);
				expect(slot().busy).toBe(false);
				expect(slot("question-2").busy).toBe(true);
				if (action === "submit") {
					expect(answer).toHaveBeenCalledWith(narratorId, "question-2", {
						answers,
						annotations: undefined,
					});
					expect(dismiss).not.toHaveBeenCalled();
				} else {
					expect(dismiss).toHaveBeenCalledWith(narratorId, "question-2");
					expect(answer).not.toHaveBeenCalled();
				}
				const busy = slots;
				await render(1, false);
				expect(slots).toBe(busy);
				await act(async () => {
					if (outcome === "success")
						deferred.resolve({ ok: true, question: question("question-2") });
					else deferred.reject(new Error("decision failed"));
				});
				await settle();
				expect(slots).not.toBe(busy);
				expect(slot("question-2").busy).toBe(false);
				expect(client.getQueryState(asyncQuestionsQueryKey(narratorId))?.isInvalidated).toBe(true);
			});
		}
	}
});
