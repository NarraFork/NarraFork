import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { AsyncQuestion, HumanAttentionDetail } from "@frontend/types/narrator";
import { MantineProvider } from "@mantine/core";
import type { HumanAttentionItem, HumanAttentionPage } from "@shared/human-attention";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterContextProvider,
} from "@tanstack/react-router";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import {
	groupHumanAttentionByScope,
	humanAttentionListKey,
	loadedHumanAttentionItems,
	useHumanAttention,
} from "../../hooks/useHumanAttention";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/api/client";
import { narratorsApi } from "../../lib/api/narrators";
import { narratorWSManager } from "../../lib/narrator-ws-manager";
import { readSession, resetSessionStoreForTest, writeSession } from "../../lib/session-store";
import commonEn from "../../locales/en/common.json";
import dashboardEn from "../../locales/en/dashboard.json";
import narratorEn from "../../locales/en/narrator.json";
import navEn from "../../locales/en/nav.json";
import { NeedsAttention } from "../dashboard/NeedsAttention";
import { NotificationCenterDrawer } from "../notifications/NotificationCenterDrawer";
import {
	HumanAttentionInboxButton,
	HumanAttentionInboxDrawer,
} from "./question/GlobalQuestionInbox";
import { PermEnterHintCtx } from "./tool-call/tool-call-contexts";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	initImmediate: false,
	// Mirror frontend/lib/i18n.ts: React already escapes, so the app does not.
	// Escaping here would make interpolated paths (`/remote/original`) unmatchable.
	interpolation: { escapeValue: false },
	resources: { en: { narrator: narratorEn, dashboard: dashboardEn, common: commonEn, nav: navEn } },
});

function item(id: string, overrides: Partial<HumanAttentionItem> = {}): HumanAttentionItem {
	return {
		id: `permission:${id}`,
		kind: "permission",
		source: "permission",
		requestId: id,
		toolCallId: `call-${id}`,
		toolName: "Bash",
		narratorId: `owner-${id}`,
		narratorTitle: `Source ${id}`,
		parentNarratorId: null,
		rootNarratorId: null,
		chapterId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		blocking: true,
		canAct: true,
		summary: `Review ${id}`,
		...overrides,
	};
}
function question(row: HumanAttentionItem): AsyncQuestion {
	return {
		id: row.requestId,
		narratorId: row.narratorId,
		toolCallId: row.toolCallId,
		toolUseId: `use-${row.requestId}`,
		questions: [{ id: "notes", header: "Notes?", options: [] }],
		answers: null,
		status: "open",
		origin: "user_deferred",
		answerMessageId: null,
		decidedBy: null,
		decidedAt: null,
		createdAt: row.createdAt,
	};
}
function testRouter() {
	return createRouter({
		routeTree: createRootRoute(),
		history: createMemoryHistory({ initialEntries: ["/narrators/parent"] }),
	});
}
let router: ReturnType<typeof testRouter>;
let qc: QueryClient;
let root: Root;
let container: HTMLDivElement;
let restoreGlobals: () => void;
let listPage: HumanAttentionPage;
let details: Map<string, HumanAttentionDetail>;
let restorers: (() => void)[];
function track<T extends { mockRestore(): void }>(spy: T): T {
	restorers.push(() => spy.mockRestore());
	return spy;
}

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
		localStorage: sessionStorage,
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
	listPage = { items: [], nextCursor: null };
	details = new Map();
	restorers = [];
	router = testRouter();
	track(spyOn(router, "navigate").mockResolvedValue(undefined));
	track(spyOn(api, "getHumanAttention").mockImplementation(async () => listPage));
	track(
		spyOn(api, "getHumanAttentionDetail").mockImplementation(async (id) => {
			const data = details.get(id);
			if (!data) throw new ApiError("Gone", 404);
			return data;
		}),
	);
});
afterEach(async () => {
	await act(async () => root.unmount());
	await settle();
	qc.clear();
	container.remove();
	for (const restore of restorers.reverse()) restore();
	resetSessionStoreForTest();
	restoreGlobals();
});
async function settle() {
	for (let n = 0; n < 3; n++)
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
}
async function render(node: ReactNode) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={qc}>
				<I18nextProvider i18n={i18n}>
					<RouterContextProvider router={router}>
						<MantineProvider env="test">{node}</MantineProvider>
					</RouterContextProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	await settle();
}
function button(label: string, within: ParentNode = document) {
	const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
		node.textContent?.includes(label),
	);
	expect(found).toBeDefined();
	return found as HTMLButtonElement;
}
function row(id: string) {
	const found = [...document.querySelectorAll<HTMLElement>("[data-attention-id]")].find(
		(node) => node.getAttribute("data-attention-id") === id,
	);
	expect(found).toBeDefined();
	return found as HTMLElement;
}
async function click(label: string, within: ParentNode = document) {
	await act(async () => button(label, within).click());
	await settle();
}
async function openDrawer() {
	await render(<HumanAttentionInboxDrawer opened onClose={() => {}} currentNarratorId="parent" />);
}
function addPermission(
	row: HumanAttentionItem,
	input: Record<string, unknown> = { command: "git diff --stat" },
) {
	listPage.items.push(row);
	details.set(row.id, {
		item: row,
		permission: {
			id: row.requestId,
			toolName: row.toolName,
			inputJson: input,
			ownerNarratorId: row.narratorId,
		},
	});
}

const draft = JSON.stringify({ selections: {}, customInputs: { notes: "Keep this answer" } });

describe("human attention global listener and pagination", () => {
	test("appears with no tabs/subscriptions, shares one listener, ignores automatic progress, reconnects and cleans up", async () => {
		const listener = track(spyOn(narratorWSManager, "addListener"));
		const remove = track(spyOn(narratorWSManager, "removeListener"));
		const subscriptions = track(spyOn(narratorWSManager, "subscribe"));
		const connection = track(spyOn(narratorWSManager, "onConnectionChange"));
		const list = spyOn(api, "getHumanAttention");
		function OtherMount() {
			useHumanAttention();
			return null;
		}
		await render(
			<>
				<HumanAttentionInboxButton currentNarratorId="parent" />
				<OtherMount />
			</>,
		);
		expect(listener).toHaveBeenCalledTimes(1);
		expect(subscriptions).not.toHaveBeenCalled();
		expect(document.querySelector("button")).toBeNull();
		const before = list.mock.calls.length;
		listPage = { items: [item("outside-tabs")], nextCursor: null };
		await act(async () =>
			narratorWSManager.dispatchLocalFrame({ type: "human_attention_changed" }),
		);
		await settle();
		expect(document.querySelector("button")?.textContent).toContain("1 pending");
		expect(list.mock.calls.length).toBe(before + 1);
		await act(async () =>
			narratorWSManager.dispatchLocalFrame({
				type: "reflection_progress",
				narratorId: "not-subscribed",
			}),
		);
		await settle();
		expect(list.mock.calls.length).toBe(before + 1);
		for (const type of [
			"narrator_access_changed",
			"project_access_changed",
			"narrator_deleted",
			"chapter_deleted",
			"project_deleted",
		]) {
			const calls = list.mock.calls.length;
			await act(async () => narratorWSManager.dispatchLocalFrame({ type, narratorId: "unknown" }));
			await settle();
			expect(list.mock.calls.length).toBe(calls + 1);
		}
		listPage = { items: [], nextCursor: null };
		await act(async () => connection.mock.calls[0][0](true, true));
		await settle();
		expect(document.querySelector("button")).toBeNull();
		await render(null);
		expect(remove).toHaveBeenCalledTimes(1);
	});

	test("omits the zero-valued current-session count", async () => {
		listPage = { items: [item("outside")], nextCursor: null };
		await render(<HumanAttentionInboxButton currentNarratorId="parent" />);
		const text = document.querySelector("button")?.textContent ?? "";
		expect(text).toContain("Other sessions 1");
		expect(text).not.toContain("Current session");
	});

	test("omits the zero-valued other-session count", async () => {
		listPage = { items: [item("inside", { narratorId: "parent" })], nextCursor: null };
		await render(<HumanAttentionInboxButton currentNarratorId="parent" />);
		const text = document.querySelector("button")?.textContent ?? "";
		expect(text).toContain("Current session 1");
		expect(text).not.toContain("Other sessions");
	});

	test("shows both non-zero session counts without extra separators", async () => {
		listPage = {
			items: [item("inside", { narratorId: "parent" }), item("outside")],
			nextCursor: null,
		};
		await render(<HumanAttentionInboxButton currentNarratorId="parent" />);
		const text = document.querySelector("button")?.textContent ?? "";
		expect(text).toContain("Current session 1 · Other sessions 1");
	});

	test("groups background children by root without losing distinct question/permission identities; lazy loads pages and details", async () => {
		const child = item("same", {
			narratorId: "background-child",
			parentNarratorId: "intermediate",
			rootNarratorId: "parent",
		});
		const asyncRow = item("same", {
			id: "question:same",
			kind: "async_question",
			source: "question",
			narratorId: "parent",
			blocking: false,
		});
		const other = item("other");
		addPermission(child);
		listPage = { items: [asyncRow, child], nextCursor: "next/opaque" };
		details.set(asyncRow.id, { item: asyncRow, question: question(asyncRow) });
		const list = spyOn(api, "getHumanAttention").mockImplementation(async (params) =>
			params?.cursor ? { items: [other], nextCursor: null } : listPage,
		);
		const detail = spyOn(api, "getHumanAttentionDetail");
		await openDrawer();
		expect(document.body.textContent).toContain("2+");
		expect(detail).not.toHaveBeenCalled();
		expect(
			[...document.querySelectorAll('[data-attention-scope="current"] [data-attention-id]')].map(
				(node) => node.getAttribute("data-attention-id"),
			),
		).toEqual([child.id, asyncRow.id]);
		await click("Review decision", row(child.id));
		expect(detail).toHaveBeenCalledTimes(1);
		expect(detail.mock.calls[0][0]).toBe(child.id);
		expect(row(child.id).textContent).toContain("Decision owner: background-child");
		await click(narratorEn.humanAttentionOpenSession, row(child.id));
		expect(router.navigate).toHaveBeenCalledWith({
			to: "/narrators/$narratorId",
			params: { narratorId: "background-child" },
		});
		await click("Load more");
		expect(list.mock.calls.at(-1)?.[0]?.cursor).toBe("next/opaque");
		expect(row(other.id).closest('[data-attention-scope="others"]')).not.toBeNull();
		expect(document.body.textContent).not.toContain("2+");
		expect(detail).toHaveBeenCalledTimes(1);
		expect(groupHumanAttentionByScope([child, asyncRow, other], "parent").current).toHaveLength(2);
		expect(
			loadedHumanAttentionItems([
				{ items: [child, asyncRow], nextCursor: "a" },
				{ items: [child, other], nextCursor: null },
			]),
		).toHaveLength(3);
	});

	test("a failed list retains an explicit retry and does not claim nothing is waiting", async () => {
		const list = spyOn(api, "getHumanAttention").mockRejectedValueOnce(new Error("network"));
		await render(<HumanAttentionInboxButton />);
		expect(document.body.textContent).toContain("Could not load human decisions");
		list.mockResolvedValue({ items: [item("retry")], nextCursor: null });
		await click("Could not load human decisions");
		expect(row("permission:retry")).toBeDefined();
	});
});

describe("child async questions from the parent attention entry", () => {
	test("global notification opens child question from parent, navigates to owner and answers only the child endpoint", async () => {
		const child = item("child-question", {
			id: "question:child-question",
			source: "question",
			kind: "async_question",
			toolName: "AskUserQuestion",
			narratorId: "actual-child",
			parentNarratorId: "parent",
			rootNarratorId: "parent",
			blocking: false,
		});
		const childQuestion = question(child);
		const parentQuestions = { items: [], openCount: 0, nextCursor: null };
		qc.setQueryData(["async-questions", "parent"], parentQuestions);
		const subscriptions = track(spyOn(narratorWSManager, "subscribe"));
		const fetchSpy = track(
			spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(Response.json({ error: "Child answer denied" }, { status: 403 }))
				.mockResolvedValueOnce(
					Response.json({ ok: true, question: { ...childQuestion, status: "answered" } }),
				),
		);
		await render(<HumanAttentionInboxButton currentNarratorId="parent" />);
		expect(document.querySelector("button")).toBeNull();
		listPage = { items: [child], nextCursor: null };
		details.set(child.id, { item: child, question: childQuestion });
		writeSession("ask-draft", child.requestId, draft);
		await act(async () =>
			narratorWSManager.dispatchLocalFrame({ type: "human_attention_changed" }),
		);
		await settle();
		expect(document.body.textContent).toContain("1 pending");
		await click("pending");
		expect(row(child.id).closest('[data-attention-scope="current"]')).not.toBeNull();
		await click(narratorEn.humanAttentionOpenSession, row(child.id));
		expect(router.navigate).toHaveBeenCalledWith({
			to: "/narrators/$narratorId",
			params: { narratorId: "actual-child" },
		});
		expect(document.querySelector("[data-attention-id]")).toBeNull();
		await click("pending");
		await click("Review decision", row(child.id));
		expect(row(child.id).textContent).toContain("Decision owner: actual-child");
		expect(row(child.id).querySelector("textarea")?.value).toBe("Keep this answer");
		await click(narratorEn.submitAnswer, row(child.id));
		expect(row(child.id).textContent).toContain("Child answer denied");
		expect(readSession("ask-draft", child.toolCallId)).not.toBeNull();
		listPage = { items: [], nextCursor: null };
		await click(narratorEn.submitAnswer, row(child.id));
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		for (const [url, init] of fetchSpy.mock.calls) {
			expect(url).toBe("/api/narrators/actual-child/questions/child-question/answer");
			expect(init?.method).toBe("POST");
			expect(JSON.parse(String(init?.body))).toEqual({ answers: { "Notes?": "Keep this answer" } });
		}
		expect(document.querySelector("[data-attention-id]")).toBeNull();
		expect(qc.getQueryData<typeof parentQuestions>(["async-questions", "parent"])).toEqual(
			parentQuestions,
		);
		expect(subscriptions).not.toHaveBeenCalled();
	});

	test("child detail ACL wins over parent grouping and prevents both answer and dismiss", async () => {
		const child = item("readonly-child", {
			id: "question:readonly-child",
			source: "question",
			kind: "async_question",
			toolName: "AskUserQuestion",
			narratorId: "readonly-child-owner",
			parentNarratorId: "parent",
			rootNarratorId: "parent",
			blocking: false,
		});
		listPage = { items: [child], nextCursor: null };
		details.set(child.id, { item: { ...child, canAct: false }, question: question(child) });
		const answer = track(spyOn(api, "answerAsyncQuestion"));
		const dismiss = track(spyOn(api, "dismissAsyncQuestion"));
		await render(<HumanAttentionInboxButton currentNarratorId="parent" />);
		await click("pending");
		await click("Review decision", row(child.id));
		expect(row(child.id).textContent).toContain("do not have permission");
		expect(row(child.id).querySelector("textarea")).toBeNull();
		expect(row(child.id).textContent).not.toContain(narratorEn.submitAnswer);
		expect(row(child.id).textContent).not.toContain(narratorEn.asyncQuestionDismiss);
		await click(narratorEn.humanAttentionOpenSession, row(child.id));
		expect(router.navigate).toHaveBeenCalledWith({
			to: "/narrators/$narratorId",
			params: { narratorId: "readonly-child-owner" },
		});
		expect(answer).not.toHaveBeenCalled();
		expect(dismiss).not.toHaveBeenCalled();
	});
});

test("notification pending panel reuses decision form, draft recovery and keyboard isolation without nested drawer", async () => {
	const child = item("notification-question", {
		source: "question",
		kind: "async_question",
		toolName: "AskUserQuestion",
		narratorId: "actual-child",
	});
	const value = question(child);
	listPage = { items: [child], nextCursor: null };
	details.set(child.id, { item: child, question: value });
	writeSession("ask-draft", child.toolCallId, draft);
	let shortcutEvents = 0;
	let rejectAnswer: (error: Error) => void = () => {};
	track(
		spyOn(api, "listNotifications").mockResolvedValue({ items: [], nextCursor: null, asOf: 123 }),
	);
	const answer = track(
		spyOn(api, "answerAsyncQuestion").mockImplementation(
			() =>
				new Promise((_resolve, reject) => {
					rejectAnswer = reject;
				}),
		),
	);
	await render(
		// biome-ignore lint/a11y/noStaticElementInteractions: Probe portal event propagation to the owning composer.
		<div onKeyDown={() => shortcutEvents++}>
			<NotificationCenterDrawer opened initialTab="attention" onClose={() => {}} />
		</div>,
	);
	expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
	await click("Review decision", row(child.id));
	const input = row(child.id).querySelector("textarea");
	expect(input?.value).toBe("Keep this answer");
	const assertIsolated = async (target: Element) => {
		for (const value of ["Enter", "ArrowLeft", "ArrowRight"]) {
			const key = new Event("keydown", { bubbles: true });
			Object.defineProperty(key, "key", { value });
			await act(async () => target.dispatchEvent(key));
		}
		expect(shortcutEvents).toBe(0);
	};
	await assertIsolated(row(child.id));
	await assertIsolated(document.querySelector('[role="dialog"] button') as Element);
	await click(narratorEn.submitAnswer, row(child.id));
	expect(answer).toHaveBeenCalledWith("actual-child", child.requestId, {
		answers: { "Notes?": "Keep this answer" },
	});
	await click(navEn.notificationTabActivity);
	await assertIsolated(
		document.querySelector('[data-testid="notification-filter-control"] button') as Element,
	);
	await assertIsolated(
		document.querySelector('[data-testid="notification-mark-all-read"]') as Element,
	);
	// Failure arrives while the pending panel is hidden; its mutation and draft owner must survive.
	await act(async () => rejectAnswer(new Error("Retry answer")));
	await settle();
	await click(navEn.notificationTabAttention);
	expect(row(child.id).querySelector("textarea")).toBe(input);
	expect(row(child.id).textContent).toContain("Retry answer");
	expect(readSession("ask-draft", child.toolCallId)).not.toBeNull();
	await assertIsolated(button(navEn.notificationTabActivity));
});

test("notification tab switches retain the expanded plan editor and unsubmitted draft", async () => {
	const plan = item("tab-plan", { toolName: "ExitPlanMode", kind: "plan_approval" });
	addPermission(plan, { plan: "Original plan" });
	writeSession(
		"permission-draft",
		plan.requestId,
		JSON.stringify({ feedback: "Unsubmitted feedback", editedPlan: "Unsubmitted edited plan" }),
	);
	track(
		spyOn(api, "listNotifications").mockResolvedValue({ items: [], nextCursor: null, asOf: 123 }),
	);
	await render(<NotificationCenterDrawer opened initialTab="attention" onClose={() => {}} />);
	await click("Review decision", row(plan.id));
	const expanded = row(plan.id);
	expect(expanded.textContent).toContain("Unsubmitted edited plan");
	const editor = button(narratorEn.planEditDone, expanded);
	await click(navEn.notificationTabActivity);
	await click(navEn.notificationTabAttention);
	expect(row(plan.id)).toBe(expanded);
	expect(button(narratorEn.planEditDone, row(plan.id))).toBe(editor);
	expect(row(plan.id).textContent).toContain("Unsubmitted edited plan");
	expect(readSession("permission-draft", plan.requestId)).toContain("Unsubmitted feedback");
});

describe("human attention decisions", () => {
	test("full plan editing, feedback and compactAfter use the original approval API; failure keeps row and draft", async () => {
		const plan = item("plan", { toolName: "ExitPlanMode", kind: "plan_approval" });
		addPermission(plan, { plan: "Original full plan\nReview every step" });
		writeSession(
			"permission-draft",
			plan.requestId,
			JSON.stringify({ feedback: "Check rollout", editedPlan: "Edited full plan\nWith tests" }),
		);
		const approve = track(
			spyOn(api, "approvePermission").mockRejectedValue(new Error("connection interrupted")),
		);
		const invalidations = track(spyOn(qc, "invalidateQueries"));
		await openDrawer();
		await click("Review decision", row(plan.id));
		expect(row(plan.id).textContent).toContain("Edited full plan");
		await click(narratorEn.planEditDone, row(plan.id));
		await click(narratorEn.acceptAndResetContext, row(plan.id));
		await click(narratorEn.planExecuteWithoutRevision);
		expect(approve).toHaveBeenCalledWith("plan", {
			feedbackText: "Check rollout",
			compactAfter: true,
			updatedPlan: "Edited full plan\nWith tests",
		});
		expect(row(plan.id).textContent).toContain("decision was not confirmed");
		expect(readSession("permission-draft", "plan")).not.toBeNull();
		for (const key of [
			["human-attention"],
			["permissions", plan.narratorId],
			["async-questions", plan.narratorId],
			["narrators", plan.narratorId],
		]) {
			expect(
				invalidations.mock.calls.some(
					([filter]) => JSON.stringify(filter?.queryKey) === JSON.stringify(key),
				),
			).toBe(true);
		}
	});

	test("a plan body renders as markdown, while a command stays literal bytes", async () => {
		const plan = item("md-plan", { toolName: "ExitPlanMode", kind: "plan_approval" });
		const command = item("md-command");
		addPermission(plan, {
			plan: [
				"# 违规请求原文留存",
				"",
				"- **预览 + 下载**：点行弹详情",
				"- 放在异常事件页 ([a.tsx](frontend/a.tsx))",
				"",
				"| 字段 | 说明 |",
				"| --- | --- |",
				"| id | 主键 |",
			].join("\n"),
		});
		// A command is the literal bytes about to run: `**` is a glob and `#` starts a
		// comment, so markdown here would misrepresent what is being approved.
		addPermission(command, { command: "rm -rf **/*.tmp # cleanup" });
		await openDrawer();
		await click("Review decision", row(plan.id));
		await click("Review decision", row(command.id));
		const planRow = row(plan.id);
		expect(planRow.querySelector("[data-md-body]")).not.toBeNull();
		expect(planRow.querySelector("h1")?.textContent).toContain("违规请求原文留存");
		expect(planRow.querySelector("strong")?.textContent).toBe("预览 + 下载");
		expect(planRow.querySelectorAll("li").length).toBe(2);
		expect(planRow.querySelector("table")).not.toBeNull();
		// Raw markdown syntax must be gone, not merely rendered alongside.
		expect(planRow.textContent).not.toContain("**预览");
		expect(planRow.textContent).not.toContain("# 违规");
		// No workspace here, so a relative file destination must not become a route.
		const fileLink = [...planRow.querySelectorAll("a")].find((node) =>
			node.textContent?.includes("a.tsx"),
		);
		expect(fileLink).toBeUndefined();
		expect(row(command.id).querySelector("[data-md-body]")).toBeNull();
		expect(row(command.id).textContent).toContain("rm -rf **/*.tmp # cleanup");
	});

	test("each item stays independently busy and denial preserves feedback and frozen remote target", async () => {
		const one = item("one");
		const two = item("two");
		addPermission(one, { command: "git push origin feature" });
		addPermission(two, { command: "dangerous command" });
		const d = details.get(two.id);
		if (d?.permission) {
			d.permission.executionDeviceId = "frozen-remote";
			d.permission.executionCwd = "/remote/original";
			d.permission.suggestions = [
				{
					type: "danger_reflection",
					status: "awaiting_user",
					reason: "Needs confirmation",
					danger: {
						severity: "high",
						consequences: ["Deletes originals"],
						saferAlternatives: ["Backup first"],
					},
				},
			];
		}
		writeSession(
			"permission-draft",
			two.requestId,
			JSON.stringify({ feedback: "Do not delete", editedPlan: null }),
		);
		let finish: (value: unknown) => void = () => {};
		const approve = track(
			spyOn(api, "approvePermission").mockImplementation(
				() =>
					new Promise((resolve) => {
						finish = resolve;
					}),
			),
		);
		const deny = track(spyOn(api, "denyPermission").mockRejectedValue(new Error("offline")));
		await openDrawer();
		await click("Review decision", row(one.id));
		await click("Review decision", row(two.id));
		await click(commonEn.allow, row(one.id));
		expect(row(one.id).querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
		expect(row(two.id).querySelector("fieldset")?.hasAttribute("disabled")).toBe(false);
		expect(row(two.id).textContent).toContain("frozen-remote");
		expect(row(two.id).textContent).toContain("/remote/original");
		expect(row(two.id).textContent).toContain(narratorEn.humanAttentionDangerConsequences);
		expect(row(two.id).textContent).toContain("Deletes originals");
		expect(row(two.id).textContent).toContain(narratorEn.humanAttentionDangerAlternatives);
		expect(row(two.id).textContent).toContain("Backup first");
		expect(row(two.id).textContent).toContain(narratorEn.humanAttentionSeverity_high);
		// Labelled rows only: a serialized payload is unreadable exactly when a human
		// is deciding, so no branch may fall back to JSON.stringify.
		expect(row(two.id).textContent).not.toContain("saferAlternatives");
		expect(row(two.id).textContent).not.toContain("danger_reflection");
		// The mounted form owns the target block; the review context must not draw a
		// second identical one, which would read as two different routings.
		expect(row(two.id).textContent?.match(/frozen-remote/g)).toHaveLength(1);
		// No captured device → no target block at all, rather than a wall of nulls.
		expect(row(one.id).textContent).not.toContain(narratorEn.executionTarget);
		expect(row(one.id).textContent).not.toContain("executionDeviceId");
		await click(commonEn.deny, row(two.id));
		expect(deny).toHaveBeenCalledWith("two", { feedbackText: "Do not delete" });
		expect(row(two.id).textContent).toContain("offline");
		await act(async () => finish({ ok: true }));
		await settle();
		expect(approve).toHaveBeenCalledTimes(1);
	});

	test("Write/Edit show full old/new input and task mutations; file review opens actual owner and never registers the inline Enter handler", async () => {
		const write = item("write", {
			toolName: "Write",
			narratorId: "child-owner",
			parentNarratorId: "parent",
		});
		const edit = item("edit", { toolName: "Edit", kind: "reflection" });
		addPermission(write, { file_path: "/remote/new.ts", content: "complete\nnew content" });
		addPermission(edit, {
			file_path: "spec://tasks.json",
			old_string: "old task",
			new_string: "new task",
		});
		const d = details.get(edit.id);
		if (d?.permission)
			d.permission.suggestions = [
				{
					type: "task_reflection",
					status: "awaiting_user",
					mutations: [{ text: "Remove protected task", status: "done" }],
					reason: "Missing completion evidence",
				},
			];
		const actions: unknown[] = [];
		await render(
			<PermEnterHintCtx.Provider
				value={{
					activePermissionId: "write",
					focusIndex: 0,
					setFocusIndex() {},
					setButtonCount: (n) => actions.push(n),
					setHasFeedback() {},
					registerActions: (a) => actions.push(a),
				}}
			>
				<HumanAttentionInboxDrawer opened onClose={() => {}} currentNarratorId="parent" />
			</PermEnterHintCtx.Provider>,
		);
		await click("Review decision", row(write.id));
		await click("Review decision", row(edit.id));
		expect(row(write.id).textContent).toContain("new content");
		expect(row(write.id).textContent).toContain("/remote/new.ts");
		expect(row(edit.id).textContent).toContain("old task");
		expect(row(edit.id).textContent).toContain("new task");
		expect(row(edit.id).textContent).toContain("Missing completion evidence");
		expect(row(edit.id).textContent).toContain(narratorEn.humanAttentionTaskChanges);
		expect(row(edit.id).textContent).toContain("Remove protected task");
		expect(row(edit.id).textContent).not.toContain("task_reflection");
		expect(row(edit.id).textContent).not.toContain("awaiting_user");
		expect(actions).toHaveLength(0);
		await click(narratorEn.fileMod_viewInPanel, row(write.id));
		expect(router.navigate).toHaveBeenCalledWith({
			to: "/narrators/$narratorId",
			params: { narratorId: "child-owner" },
		});
	});

	test("read-only and oversized forms cannot submit, while the owner session remains reachable", async () => {
		const readonly = item("readonly", { canAct: false });
		const oversized = item("oversized");
		addPermission(readonly);
		addPermission(oversized);
		details.set(oversized.id, { item: oversized, tooLarge: true });
		const approve = track(spyOn(api, "approvePermission"));
		await openDrawer();
		await click("Review decision", row(readonly.id));
		await click("Review decision", row(oversized.id));
		expect(row(readonly.id).querySelector("textarea")).toBeNull();
		expect(row(readonly.id).textContent).toContain("do not have permission");
		expect(row(oversized.id).textContent).toContain("too large");
		expect(row(oversized.id).querySelector("fieldset")).toBeNull();
		await click(narratorEn.humanAttentionOpenSession, row(oversized.id));
		expect(router.navigate).toHaveBeenCalledWith({
			to: "/narrators/$narratorId",
			params: { narratorId: "owner-oversized" },
		});
		expect(approve).not.toHaveBeenCalled();
	});

	test("blocking answers and defer use permission identity; async retains annotations and legacy draft identity", async () => {
		const blocking = item("block", { toolName: "AskUserQuestion", kind: "blocking_question" });
		const asyncRow = item("async", {
			id: "question:async",
			source: "question",
			kind: "async_question",
			toolName: "AskUserQuestion",
			blocking: false,
		});
		addPermission(blocking, {
			questions: [
				{
					question: "notes",
					header: "Notes?",
					options: [{ label: "Ship it", description: "Commit the current result" }],
				},
			],
		});
		const asyncQuestion = {
			...question(asyncRow),
			annotations: { notes: { preview: "Existing preview", notes: "Existing annotation" } },
		};
		listPage.items.push(asyncRow);
		details.set(asyncRow.id, { item: asyncRow, question: asyncQuestion });
		writeSession("ask-draft", blocking.toolCallId, draft);
		writeSession("ask-draft", asyncRow.requestId, draft);
		const defer = track(
			spyOn(api, "deferPermissionQuestion").mockRejectedValue(new Error("retry defer")),
		);
		const approve = track(spyOn(api, "approvePermission").mockResolvedValue({ ok: true }));
		const answer = track(
			spyOn(api, "answerAsyncQuestion").mockRejectedValue(new Error("retry answer")),
		);
		await openDrawer();
		await click("Review decision", row(blocking.id));
		await click("Review decision", row(asyncRow.id));
		expect(row(asyncRow.id).querySelector("textarea")?.value).toBe("Keep this answer");
		// The banner below IS the questions input. Echoing it as JSON above the real
		// form showed every label/description twice and leaked the wire shape.
		expect(row(blocking.id).textContent?.match(/Ship it/g)).toHaveLength(1);
		expect(row(blocking.id).textContent).not.toContain('"options"');
		expect(row(blocking.id).textContent).not.toContain('"header"');
		// A question routes nowhere, so no execution target is claimed for it.
		expect(row(blocking.id).textContent).not.toContain(narratorEn.executionTarget);
		await click(narratorEn.deferQuestion, row(blocking.id));
		expect(defer).toHaveBeenCalledWith("block");
		expect(readSession("ask-draft", blocking.toolCallId)).not.toBeNull();
		await click(narratorEn.submitAnswer, row(blocking.id));
		expect(approve).toHaveBeenCalledWith("block", { answers: { "Notes?": "Keep this answer" } });
		await click(narratorEn.submitAnswer, row(asyncRow.id));
		expect(answer).toHaveBeenCalledWith(asyncRow.narratorId, "async", {
			answers: { "Notes?": "Keep this answer" },
			annotations: asyncQuestion.annotations,
		});
		expect(readSession("ask-draft", asyncRow.toolCallId)).not.toBeNull();
		expect(row(asyncRow.id).textContent).not.toContain(narratorEn.deferQuestion);
	});

	test("404 detail and 409 decision refetch the authority without looping or optimistic removals", async () => {
		const gone = item("gone");
		addPermission(gone);
		const detail = spyOn(api, "getHumanAttentionDetail").mockRejectedValue(
			new ApiError("already handled", 404),
		);
		const list = spyOn(api, "getHumanAttention");
		await openDrawer();
		await click("Review decision", row(gone.id));
		expect(detail).toHaveBeenCalledTimes(1);
		expect(list.mock.calls.length).toBeLessThanOrEqual(3);
		expect(row(gone.id).textContent).toContain("no longer visible");
		detail.mockResolvedValue(details.get(gone.id) as HumanAttentionDetail);
		await click("Refresh / retry", row(gone.id));
		const approve = track(
			spyOn(api, "approvePermission").mockImplementation(async () => {
				listPage = { items: [], nextCursor: null };
				throw new ApiError("already decided", 409);
			}),
		);
		await click(commonEn.allow, row(gone.id));
		expect(approve).toHaveBeenCalledTimes(1);
		expect(document.querySelector("[data-attention-id]")).toBeNull();
	});
});

test("API encodes opaque identities/cursors and forwards the query AbortSignal", async () => {
	const signal = new AbortController().signal;
	const opaqueId = "permission:child/% request";
	const expectedDetail = { item: item("encoded") };
	const fetchSpy = track(
		spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json({ items: [], nextCursor: "opaque/next" }))
			.mockResolvedValueOnce(Response.json(expectedDetail)),
	);
	expect(
		await narratorsApi.getHumanAttention({ cursor: "cursor/+ value", limit: 17 }, signal),
	).toEqual({ items: [], nextCursor: "opaque/next" });
	expect(fetchSpy.mock.calls[0][0]).toBe(
		"/api/narrators/human-attention?cursor=cursor%2F%2B+value&limit=17",
	);
	expect(fetchSpy.mock.calls[0][1]?.signal).toBe(signal);
	expect(await narratorsApi.getHumanAttentionDetail(opaqueId, signal)).toEqual(expectedDetail);
	expect(fetchSpy.mock.calls[1][0]).toBe(
		`/api/narrators/human-attention/${encodeURIComponent(opaqueId)}`,
	);
	expect(fetchSpy.mock.calls[1][1]?.signal).toBe(signal);
});

test("an empty scanned page with a next cursor stays loadable, rather than claiming an empty inbox", async () => {
	const next = item("beyond-acl-window");
	spyOn(api, "getHumanAttention").mockImplementation(async (params) =>
		params?.cursor
			? { items: [next], nextCursor: null }
			: { items: [], nextCursor: "continue-acl-scan" },
	);
	await render(<HumanAttentionInboxButton />);
	expect(document.body.textContent).toContain("0+");
	await click("pending");
	expect(document.body.textContent).not.toContain("Nothing waiting for a human decision");
	await click("Load more");
	expect(row(next.id)).toBeDefined();
});

test("detail failures offer retry, and ACL changes remove decision controls without relying on tabs", async () => {
	const permission = item("acl");
	addPermission(permission);
	spyOn(api, "getHumanAttentionDetail").mockRejectedValueOnce(new Error("network"));
	const approve = track(spyOn(api, "approvePermission"));
	await openDrawer();
	await click("Review decision", row(permission.id));
	expect(row(permission.id).textContent).toContain("Could not load");
	await click("Refresh / retry", row(permission.id));
	expect(button(commonEn.allow, row(permission.id))).toBeDefined();
	const readOnly = { ...permission, canAct: false };
	listPage = { items: [readOnly], nextCursor: null };
	const old = details.get(permission.id) as HumanAttentionDetail;
	details.set(permission.id, { ...old, item: readOnly });
	await act(async () =>
		narratorWSManager.dispatchLocalFrame({
			type: "narrator_access_changed",
			narratorId: permission.narratorId,
		}),
	);
	await settle();
	expect(row(permission.id).querySelector("textarea")).toBeNull();
	expect(row(permission.id).textContent).toContain("do not have permission");
	expect(approve).not.toHaveBeenCalled();
});

test("failed blocking question reflection keeps its draft and explicit retry", async () => {
	const blocking = item("reflect", { toolName: "AskUserQuestion", kind: "blocking_question" });
	addPermission(blocking, { questions: question(blocking).questions });
	writeSession("ask-draft", blocking.toolCallId, draft);
	const reflect = track(
		spyOn(api, "reflectQuestion").mockRejectedValue(new Error("reflection offline")),
	);
	await openDrawer();
	await click("Review decision", row(blocking.id));
	await click(narratorEn.questionReflectionAnswer, row(blocking.id));
	expect(reflect).toHaveBeenCalledWith(blocking.requestId);
	expect(row(blocking.id).textContent).toContain("reflection offline");
	expect(readSession("ask-draft", blocking.toolCallId)).not.toBeNull();
});

test("Dashboard uses summaries only and View all opens the same drawer", async () => {
	addPermission(item("dashboard"));
	const narrators = track(
		spyOn(api, "listNarratorsPaginated").mockResolvedValue({
			items: [],
			nextCursor: null,
			hasMore: false,
			totalCount: 0,
		}),
	);
	const permissions = track(spyOn(api, "getPendingPermissions"));
	const detail = spyOn(api, "getHumanAttentionDetail");
	await render(<NeedsAttention />);
	expect(narrators).toHaveBeenCalledTimes(1);
	expect(narrators.mock.calls[0][0]?.status).toBeUndefined();
	expect(permissions).not.toHaveBeenCalled();
	expect(detail).not.toHaveBeenCalled();
	await click("View all");
	expect(document.body.textContent).toContain("Human attention center");
	expect(row("permission:dashboard")).toBeDefined();
	expect(detail).not.toHaveBeenCalled();
	expect(qc.getQueryData(humanAttentionListKey)).toMatchObject({
		pages: [{ items: [{ id: "permission:dashboard" }] }],
	});
});
