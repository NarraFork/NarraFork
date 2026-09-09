import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useRevertHistoryAction } from "@frontend/hooks/useNarrator";
import type {
	RevertActionConfirmOptions,
	RevertActionPlan,
	RevertActionPreview,
	RevertPlanFile,
	RevertScope,
	RevertScopePreviews,
	ScopedRevertUnavailableReason,
} from "@frontend/lib/api/narrators";
import { MantineProvider } from "@mantine/core";
import { notifications, notificationsStore } from "@mantine/notifications";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../locales/en/narrator.json";
import zh from "../../locales/zh-CN/narrator.json";
import {
	RevertActionConfirmModal,
	RevertScopeConfirmModal,
	type RevertScopeConfirmModalProps,
} from "./RevertScopeConfirmModal";

// Render real hooks, API helpers and Mantine controls; only fetch is intercepted.
// The Bun preload isolates HOME/NARRAFORK_HOME before this frontend-only suite imports.
const i18n = i18next.createInstance();
let root: Root | undefined;
let props: RevertScopeConfirmModalProps;
let confirmations: RevertActionConfirmOptions[];
let queryClient: QueryClient;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
let requests: CapturedRequest[];
let respond: (request: CapturedRequest) => Response | Promise<Response>;
let action: "rollback_to_block" | "delete_tool_block";
let pending: { messageId: string; blockIndex: number } | null;
let execute: boolean;
let applyErrors: unknown[];

interface CapturedRequest {
	url: URL;
	method: string;
	body: Record<string, unknown> | undefined;
	signal: AbortSignal | null | undefined;
}

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

class TestMutationObserver {
	observe() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}

function overrideGlobal(name: string, value: unknown) {
	if (!previousGlobals.has(name))
		previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
}

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	const storage = new Map<string, string>();
	const matchMedia = (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener() {},
		removeListener() {},
		addEventListener() {},
		removeEventListener() {},
		dispatchEvent: () => false,
	});
	Object.assign(window, {
		matchMedia,
		ResizeObserver: TestResizeObserver,
		MutationObserver: TestMutationObserver,
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
	});
	const overrides = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLAnchorElement: window.HTMLAnchorElement,
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
			clear: () => storage.clear(),
		},
		Element: window.Element,
		Node: window.Node,
		Text: window.Text,
		ResizeObserver: TestResizeObserver,
		MutationObserver: TestMutationObserver,
		matchMedia,
		requestAnimationFrame: window.requestAnimationFrame,
		cancelAnimationFrame: window.cancelAnimationFrame,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		IS_REACT_ACT_ENVIRONMENT: false,
	};
	for (const [name, value] of Object.entries(overrides)) overrideGlobal(name, value);
}

function completePreview(overrides: Partial<RevertScopePreviews> = {}): RevertScopePreviews {
	const ours = { deviceId: "local", filePath: "/workspace/ours.ts", willBeDeleted: false };
	const other = { deviceId: "local", filePath: "/workspace/other.ts", willBeDeleted: true };
	return {
		scope: "narrator",
		affectedFiles: [ours],
		narratorScope: {
			available: true,
			files: [ours],
			conflicts: [],
			totalFileCount: 1,
			hasMore: false,
		},
		workspaceScope: { available: true, files: [ours, other], warnings: [] },
		...overrides,
	};
}

function workspaceOnlyPreview(): RevertScopePreviews {
	return completePreview({
		scope: "workspace",
		narratorScope: { available: false, reason: "legacy_unverified", files: [], conflicts: [] },
	});
}

async function flush() {
	for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function render(overrides: Partial<RevertScopeConfirmModalProps> = {}) {
	props = { ...props, ...overrides };
	root?.render(
		<I18nextProvider i18n={i18n}>
			<MantineProvider env="test">
				<RevertScopeConfirmModal {...props} />
			</MantineProvider>
		</I18nextProvider>,
	);
	await flush();
}

function button(label: string): HTMLButtonElement {
	const element = Array.from(document.body.querySelectorAll("button")).find(
		(candidate) => candidate.textContent?.trim() === label,
	);
	if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
	return element;
}

function scopeRadio(scope: RevertScope): HTMLInputElement {
	const element = document.body.querySelector(`input[type="radio"][value="${scope}"]`);
	if (!(element instanceof HTMLInputElement)) throw new Error(`Missing scope: ${scope}`);
	return element;
}

async function click(element: HTMLElement) {
	element.dispatchEvent(new Event("click", { bubbles: true }));
	await flush();
}

async function selectScope(scope: RevertScope) {
	const radio = scopeRadio(scope);
	expect(radio.disabled).toBe(false);
	// linkedom has no radio activation behaviour. React listens to the click,
	// rather than a synthetic change event, just as it does for checkboxes.
	radio.checked = true;
	await click(radio);
}

function assertUnavailable(locale: typeof en | typeof zh = en) {
	expect(button(locale.revertScopeUnavailableTitle).disabled).toBe(true);
	expect(document.body.textContent).not.toContain(locale.rollbackConfirmNoFiles);
	expect(document.body.textContent).not.toContain(locale.revertScopeNothingOwned);
	expect(button(props.messagesOnlyLabel).disabled).toBe(false);
}

beforeEach(async () => {
	installDom();
	requests = [];
	respond = () => {
		throw new Error("Unexpected HTTP request in fixture");
	};
	overrideGlobal(
		"fetch",
		Object.assign(
			async (input: string | URL | Request, init?: RequestInit) => {
				const request = {
					url: new URL(String(input), "https://test.invalid"),
					method: init?.method ?? "GET",
					body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
					signal: init?.signal,
				};
				requests.push(request);
				return respond(request);
			},
			{ preconnect() {} },
		),
	);
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: 3, retryDelay: 0 } },
	});
	action = "rollback_to_block";
	pending = { messageId: "message-1", blockIndex: 3 };
	execute = false;
	applyErrors = [];
	notifications.clean();
	if (!i18n.isInitialized) {
		await i18n.use(initReactI18next).init({
			lng: "en",
			fallbackLng: "en",
			defaultNS: "narrator",
			resources: { en: { narrator: en }, "zh-CN": { narrator: zh } },
			interpolation: { escapeValue: false },
			react: { useSuspense: false },
		});
	}
	await i18n.changeLanguage("en");
	confirmations = [];
	props = {
		opened: true,
		title: "Confirm rollback",
		description: "Delete the selected history.",
		data: undefined,
		isLoading: false,
		confirmWithRevertLabel: en.rollbackConfirmWithRevert,
		confirmNoFilesLabel: en.rollbackConfirm,
		messagesOnlyLabel: en.rollbackConfirmMessagesOnly,
		onConfirm: (opts) => confirmations.push(opts),
		onCancel: () => {},
	};
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	root?.unmount();
	root = undefined;
	queryClient.clear();
	notifications.clean();
	await flush();
	for (const [name, descriptor] of previousGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	previousGlobals.clear();
});

describe("RevertScopeConfirmModal evidence gating", () => {
	for (const hasCachedData of [false, true]) {
		test(`loading blocks file rollback but retains history-only (cached=${hasCachedData})`, async () => {
			await render({ isLoading: true, data: hasCachedData ? completePreview() : undefined });
			assertUnavailable();
			await click(button(en.revertScopeUnavailableTitle));
			expect(confirmations).toEqual([]);
			await click(button(props.messagesOnlyLabel));
			expect(confirmations).toEqual([{ skipRevert: true }]);
		});
	}

	test("a failed or missing preview is not an empty file set", async () => {
		await render();
		assertUnavailable();
		expect(document.body.textContent).toContain(en.revertScopeUnavailable);
		await click(button(props.messagesOnlyLabel));
		expect(confirmations).toEqual([{ skipRevert: true }]);
	});

	test("legacy files stay viewable without promising to revert or delete them", async () => {
		await render({ data: { affectedFiles: completePreview().workspaceScope?.files ?? [] } });
		assertUnavailable();
		expect(document.body.textContent).toContain(en.revertScopeLegacyUnverified);
		expect(document.body.textContent).toContain(en.revertScopeRecordedFiles);
		expect(document.body.textContent).toContain("/workspace/other.ts");
		expect(document.body.textContent).not.toContain(en.rollbackConfirmFiles);
		expect(document.body.textContent).not.toContain(en.fileMod_willBeDeleted);
		expect(document.body.textContent).not.toContain(en.fileMod_willBeReverted);
		await click(button(en.revertScopeUnavailableTitle));
		expect(confirmations).toEqual([]);
	});

	for (const scope of [undefined, "future_scope" as RevertScope]) {
		test(`missing or unknown scope metadata blocks otherwise available previews (${scope})`, async () => {
			await render({ data: completePreview({ scope }) });
			assertUnavailable();
			expect(scopeRadio("narrator").disabled).toBe(true);
			expect(scopeRadio("workspace").disabled).toBe(true);
		});
	}

	test("a known scope without its preview is unavailable", async () => {
		await render({ data: { scope: "narrator", affectedFiles: [] } });
		assertUnavailable();
	});

	for (const truncated of [{ hasMore: true }, { totalFileCount: 2 }]) {
		test(`a partially listed narrator scope is not executable (${JSON.stringify(truncated)})`, async () => {
			const data = completePreview();
			Object.assign(data.narratorScope ?? {}, truncated);
			await render({ data });
			assertUnavailable();
			expect(document.body.textContent).toContain(en.revertScopePreviewTruncated);
			expect(document.body.textContent).toContain("/workspace/ours.ts");
			await click(button(en.revertScopeUnavailableTitle));
			expect(confirmations).toEqual([]);
		});
	}

	test("a narrator scope without a conflict assessment is not verified", async () => {
		const data = completePreview();
		if (data.narratorScope) data.narratorScope.conflicts = undefined as unknown as string[];
		await render({ data });
		assertUnavailable();
	});

	test("conflicts block narrator rollback rather than selecting workspace", async () => {
		const data = completePreview({ scope: "workspace" });
		if (data.narratorScope) data.narratorScope.conflicts = ["/workspace/ours.ts"];
		await render({ data });
		assertUnavailable();
		expect(scopeRadio("workspace").checked).toBe(false);
		expect(document.body.textContent).toContain(en.revertScopeConflictTitle);
	});

	test("complete conflict-free evidence retains the positive narrator confirmation", async () => {
		await render({ data: completePreview() });
		expect(button(props.confirmWithRevertLabel).disabled).toBe(false);
		expect(document.body.textContent).toContain(en.rollbackConfirmFiles);
		await click(button(props.confirmWithRevertLabel));
		expect(confirmations).toEqual([{ skipRevert: false, scope: "narrator" }]);
	});

	for (const reason of [undefined, "nothing_owned"] as const) {
		test(`verified empty scope stays narrow (${reason})`, async () => {
			await render({
				data: completePreview({
					narratorScope: { available: true, reason, files: [], conflicts: [] },
				}),
			});
			expect(document.body.textContent).toContain(
				reason ? en.revertScopeNothingOwned : en.rollbackConfirmNoFiles,
			);
			await click(button(props.confirmNoFilesLabel));
			expect(confirmations).toEqual([{ skipRevert: false, scope: "narrator" }]);
		});
	}

	test("submitting disables both destructive and history-only confirmation", async () => {
		await render({ data: completePreview(), submitting: true });
		expect(button(props.confirmWithRevertLabel).disabled).toBe(true);
		expect(button(props.messagesOnlyLabel).disabled).toBe(true);
		await click(button(props.confirmWithRevertLabel));
		await click(button(props.messagesOnlyLabel));
		expect(confirmations).toEqual([]);
	});
});

describe("RevertScopeConfirmModal explicit workspace consent", () => {
	test("an unavailable narrator and a workspace recommendation do not widen the selection", async () => {
		await render({ data: workspaceOnlyPreview() });
		assertUnavailable();
		expect(scopeRadio("narrator").checked).toBe(true);
		expect(scopeRadio("narrator").disabled).toBe(true);
		expect(scopeRadio("workspace").checked).toBe(false);
		expect(document.body.textContent).toContain(en.revertScopeWorkspaceExplicit);
		await click(button(en.revertScopeUnavailableTitle));
		expect(confirmations).toEqual([]);

		await selectScope("workspace");
		expect(document.body.textContent).toContain(en.revertScopeWorkspaceWarning);
		expect(document.body.textContent).toContain("/workspace/other.ts");
		await click(button(props.confirmWithRevertLabel));
		expect(confirmations).toEqual([{ skipRevert: false, scope: "workspace" }]);
	});

	test("an unavailable workspace cannot be selected even if recommended", async () => {
		await render({
			data: workspaceOnlyPreviewWithUnavailableWorkspace(),
		});
		assertUnavailable();
		expect(scopeRadio("workspace").disabled).toBe(true);
		await click(scopeRadio("workspace"));
		assertUnavailable();
	});

	test("the selected workspace becoming unavailable blocks confirmation immediately", async () => {
		const data = workspaceOnlyPreview();
		await render({ data });
		await selectScope("workspace");
		if (data.workspaceScope) {
			data.workspaceScope.available = false;
			data.workspaceScope.reason = "snapshot_missing";
		}
		// Same object to exercise the execution guard independently of consent reset.
		await render({ data });
		assertUnavailable();
		expect(document.body.textContent).toContain(en.revertScopeSnapshotMissing);
		await click(button(en.revertScopeUnavailableTitle));
		expect(confirmations).toEqual([]);
	});

	test("a new preview invalidates workspace consent even if its recommendation is unchanged", async () => {
		await render({ data: workspaceOnlyPreview() });
		await selectScope("workspace");
		await render({ data: workspaceOnlyPreview() });
		assertUnavailable();
		expect(scopeRadio("workspace").checked).toBe(false);
		await selectScope("workspace");
		await click(button(props.confirmWithRevertLabel));
		expect(confirmations).toEqual([{ skipRevert: false, scope: "workspace" }]);
	});

	test("closing and reopening with the same preview requires workspace consent again", async () => {
		const data = workspaceOnlyPreview();
		await render({ data });
		await selectScope("workspace");
		await render({ opened: false });
		await render({ opened: true });
		assertUnavailable();
		expect(scopeRadio("workspace").checked).toBe(false);
	});

	test("a loading cycle invalidates an earlier workspace choice", async () => {
		await render({ data: workspaceOnlyPreview() });
		await selectScope("workspace");
		await render({ isLoading: true });
		assertUnavailable();
		await render({ isLoading: false });
		assertUnavailable();
		expect(scopeRadio("workspace").checked).toBe(false);
	});

	test("switching back to narrator uses its own file set and confirmation scope", async () => {
		await render({ data: completePreview() });
		await selectScope("workspace");
		expect(document.body.textContent).toContain("/workspace/other.ts");
		await selectScope("narrator");
		expect(document.body.textContent).not.toContain("/workspace/other.ts");
		await click(button(props.confirmWithRevertLabel));
		expect(confirmations).toEqual([{ skipRevert: false, scope: "narrator" }]);
	});
});

function workspaceOnlyPreviewWithUnavailableWorkspace(): RevertScopePreviews {
	return {
		...workspaceOnlyPreview(),
		workspaceScope: {
			available: false,
			reason: "incomplete_coverage",
			files: [],
			warnings: [],
		},
	};
}

function preparedActionPreview(overrides: Partial<RevertActionPlan> = {}): RevertActionPreview {
	return {
		action,
		executable: false,
		historySummary: { deletedMessageCount: 4, deletedBlockCount: 2 },
		plan: {
			id: "plan-1",
			planHash: "hash-plan-1",
			status: "prepared",
			coverageComplete: true,
			expectedFileCount: 2,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			expired: false,
			kind: action === "rollback_to_block" ? "rollback_to_block" : "history_delete",
			selectorKind: action === "rollback_to_block" ? "after_block" : "tool_calls",
			...overrides,
		},
	};
}

function planFile(index: number): RevertPlanFile {
	return {
		id: `file-${index}`,
		fileKey: `key-${index}`,
		sequence: index,
		identityJson: {
			deviceId: "device-test",
			displayPath: `/workspace/file-${index}.ts`,
			lexicalPath: `/workspace/file-${index}.ts`,
			canonicalPath: `/workspace/file-${index}.ts`,
		},
		expectedStateJson: { kind: "regular" },
		desiredStateJson: { kind: index === 1 ? "absent" : "regular" },
	};
}

function reply(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function filesReply(items: RevertPlanFile[], hasMore = false) {
	return reply({
		items,
		hasMore,
		nextCursor: hasMore ? { fileKey: items.at(-1)?.fileKey } : null,
		executable: false,
	});
}

function normalResponse(request: CapturedRequest): Response {
	if (request.url.pathname.endsWith("/revert-action-preview"))
		return reply(preparedActionPreview());
	if (request.url.pathname.endsWith("/files")) return filesReply([planFile(0), planFile(1)]);
	if (request.url.pathname.endsWith("/apply")) {
		return reply({
			planId: "plan-1",
			status: "committed",
			journalStatus: "committed",
			settling: false,
			reason: null,
		});
	}
	if (request.method === "DELETE" || request.url.pathname.includes("/rollback/")) {
		return reply({ ok: true, messageDeleted: false });
	}
	throw new Error(`Unexpected fixture request: ${request.url}`);
}

function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function ActionFlow({
	target,
	selectedAction,
}: {
	target: typeof pending;
	selectedAction: typeof action;
}) {
	const mutation = useRevertHistoryAction("narrator-test");
	return (
		<RevertActionConfirmModal
			narratorId="narrator-test"
			action={selectedAction}
			pending={target}
			submitting={mutation.isPending}
			onCancel={() => {}}
			onConfirm={(opts) => {
				confirmations.push(opts);
				if (execute && target) {
					void mutation.mutateAsync({ action: selectedAction, target, opts }).catch((error) => {
						applyErrors.push(error);
					});
				}
			}}
		/>
	);
}

async function renderAction() {
	props.messagesOnlyLabel =
		action === "rollback_to_block" ? en.rollbackConfirmMessagesOnly : en.blockDeleteHistoryOnly;
	root?.render(
		<I18nextProvider i18n={i18n}>
			<QueryClientProvider client={queryClient}>
				<MantineProvider env="test">
					<ActionFlow target={pending} selectedAction={action} />
				</MantineProvider>
			</QueryClientProvider>
		</I18nextProvider>,
	);
	await flush();
}

async function waitFor(check: () => boolean) {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (check()) return;
		await flush();
	}
	throw new Error("UI condition did not settle");
}

function requestsTo(suffix: string) {
	return requests.filter((request) => request.url.pathname.endsWith(suffix));
}

function fixedPreview(): RevertScopePreviews {
	const plan = preparedActionPreview({ expectedFileCount: 1 }).plan;
	if (!plan) throw new Error("Missing fixture plan");
	return completePreview({
		workspaceScope: undefined,
		revertPlan: { ...plan, planId: plan.id, action, previewKey: "opening-1", filesComplete: true },
	});
}

describe("fixed plan external-write boundary", () => {
	for (const [language, locale] of Object.entries({ en, "zh-CN": zh })) {
		test(`${language}: every available plan review warns about uncoordinated writes, including empty plans`, async () => {
			await i18n.changeLanguage(language);
			for (const empty of [false, true]) {
				const data = fixedPreview();
				if (empty) {
					if (data.revertPlan) data.revertPlan.expectedFileCount = 0;
					data.affectedFiles = [];
					data.narratorScope = { available: true, files: [], conflicts: [] };
				}
				await render({ data, previewKey: "opening-1" });
				expect(
					button(empty ? props.confirmNoFilesLabel : props.confirmWithRevertLabel).disabled,
				).toBe(false);
				expect(document.body.textContent).toContain(locale.revertPlanExternalWritesWarning);
			}
		});

		test(`${language}: the new boundary notice does not leak into legacy scope dialogs`, async () => {
			await i18n.changeLanguage(language);
			await render({ data: completePreview() });
			expect(document.body.textContent).not.toContain(locale.revertPlanExternalWritesWarning);
			await selectScope("workspace");
			expect(document.body.textContent).not.toContain(locale.revertPlanExternalWritesWarning);
			await render({ data: { affectedFiles: completePreview().affectedFiles } });
			expect(document.body.textContent).not.toContain(locale.revertPlanExternalWritesWarning);
		});

		test(`${language}: an incomplete plan is not presented as an available review`, async () => {
			await i18n.changeLanguage(language);
			const data = fixedPreview();
			if (data.revertPlan) data.revertPlan.coverageComplete = false;
			await render({ data, previewKey: "opening-1" });
			assertUnavailable(locale);
			expect(document.body.textContent).not.toContain(locale.revertPlanExternalWritesWarning);
		});
	}
});

describe("fixed plan confirmation guards", () => {
	test("conflict-free but unavailable scope never enables a block deletion", async () => {
		await render({
			data: completePreview({ narratorScope: { available: false, files: [], conflicts: [] } }),
		});
		assertUnavailable();
	});

	test("the new flow cannot fall back to a legacy available scope without a plan", async () => {
		await render({ data: completePreview(), previewKey: "opening-1" });
		assertUnavailable();
	});

	test("only the reviewed id/hash/action is passed to confirmation", async () => {
		await render({ data: fixedPreview(), previewKey: "opening-1" });
		await click(button(en.rollbackConfirmWithRevert));
		expect(confirmations).toEqual([
			{
				skipRevert: false,
				revertPlan: { planId: "plan-1", planHash: "hash-plan-1", action: "rollback_to_block" },
			},
		]);
		assertUnavailable();
	});

	for (const patch of [
		{ status: "planned" },
		{ coverageComplete: false },
		{ planHash: null },
		{ expired: true },
		{ expiresAt: new Date(0).toISOString() },
		{ expiresAt: "invalid-date" },
		{ filesComplete: false },
		{ expectedFileCount: 2 },
		{ previewKey: "previous-opening" },
	]) {
		test(`ineligible plan is blocked despite an available scope: ${JSON.stringify(patch)}`, async () => {
			const data = fixedPreview();
			Object.assign(data.revertPlan ?? {}, patch);
			await render({ data, previewKey: "opening-1" });
			assertUnavailable();
			await click(button(en.revertScopeUnavailableTitle));
			expect(confirmations).toEqual([]);
		});
	}

	for (const stateChange of ["reopen", "loading"] as const) {
		test(`${stateChange} revokes the same previously ready plan`, async () => {
			await render({ data: fixedPreview(), previewKey: "opening-1" });
			if (stateChange === "reopen") {
				await render({ opened: false });
				await render({ opened: true });
			} else {
				await render({ isLoading: true });
				await render({ isLoading: false });
			}
			assertUnavailable();
			expect(document.body.textContent).toContain(en.revertPlanReloadRequired);
		});
	}
});

describe("fixed action preview HTTP flow", () => {
	test("verified zero-file plan still loads its terminal page before enabling confirmation", async () => {
		const files = deferredResponse();
		respond = (request) =>
			request.url.pathname.endsWith("/files")
				? files.promise
				: reply(preparedActionPreview({ expectedFileCount: 0 }));
		await renderAction();
		assertUnavailable();
		files.resolve(filesReply([]));
		await flush();
		expect(document.body.textContent).toContain(en.rollbackConfirmNoFiles);
		expect(button(en.rollbackConfirm).disabled).toBe(false);
		await click(button(en.rollbackConfirm));
		expect(confirmations[0]?.revertPlan?.planId).toBe("plan-1");
	});

	for (const fault of ["wrong_action", "missing_summary", "malformed_json"] as const) {
		test(`invalid success payload is not a verified preview: ${fault}`, async () => {
			respond = () =>
				fault === "malformed_json"
					? new Response("{broken", { headers: { "content-type": "application/json" } })
					: reply({
							...preparedActionPreview(),
							...(fault === "wrong_action"
								? { action: "delete_tool_block" }
								: { historySummary: null }),
						});
			await renderAction();
			assertUnavailable();
			expect(document.body.textContent).toContain(en.revertPlanPreviewFailed);
			expect(requestsTo("/files")).toHaveLength(0);
		});
	}

	test("all pages, exact counts and actual paths are reviewed before confirmation", async () => {
		const next = deferredResponse();
		respond = (request) => {
			if (request.url.pathname.endsWith("/files")) {
				return request.url.searchParams.has("cursor")
					? next.promise
					: filesReply([planFile(0)], true);
			}
			return normalResponse(request);
		};
		await renderAction();
		await waitFor(() => requestsTo("/files").length === 2);
		assertUnavailable();
		expect(requestsTo("/files")[0].url.searchParams.get("limit")).toBe("32");
		expect(requestsTo("/files")[1].url.searchParams.get("cursor")).toBe("key-0");
		expect(requestsTo("/files")[1].url.pathname).toContain("/revert-plans/plan-1/files");
		next.resolve(filesReply([planFile(1)]));
		await waitFor(() => document.body.textContent?.includes(en.rollbackConfirmWithRevert) === true);
		expect(button(en.rollbackConfirmWithRevert).disabled).toBe(false);
		expect(document.body.textContent).toContain("This plan deletes 4 message(s) and 2 block(s).");
		expect(document.body.textContent).toContain("/workspace/file-0.ts");
		expect(document.body.textContent).toContain("/workspace/file-1.ts");
		expect(document.body.textContent).toContain("device-test");
		expect(document.body.textContent).toContain(en.fileMod_willBeDeleted);
		expect(document.body.textContent).toContain(en.fileMod_willBeReverted);
		await click(button(en.rollbackConfirmWithRevert));
		expect(confirmations[0]?.revertPlan).toEqual({
			planId: "plan-1",
			planHash: "hash-plan-1",
			action,
		});
		const post = requestsTo("/revert-action-preview")[0];
		expect(post.method).toBe("POST");
		expect(post.body).toMatchObject({ action, messageId: "message-1", blockIndex: 3 });
		expect(typeof post.body?.idempotencyKey).toBe("string");
	});

	for (const endpoint of ["/revert-action-preview", "/files"]) {
		test(`failed ${endpoint} is not empty success and is never automatically retried`, async () => {
			respond = (request) =>
				request.url.pathname.endsWith(endpoint)
					? reply({ error: "fixture request failed" }, 503)
					: normalResponse(request);
			await renderAction();
			assertUnavailable();
			expect(document.body.textContent).toContain(en.revertPlanPreviewFailed);
			expect(document.body.textContent).toContain("fixture request failed");
			await flush();
			expect(requestsTo(endpoint)).toHaveLength(1);
			await click(button(props.messagesOnlyLabel));
			expect(confirmations).toEqual([{ skipRevert: true }]);
		});
	}

	for (const fault of ["count", "duplicate", "cursor", "unknown_state"] as const) {
		test(`incomplete pagination fails closed: ${fault}`, async () => {
			respond = (request) => {
				if (!request.url.pathname.endsWith("/files")) return normalResponse(request);
				if (fault === "count") return filesReply([planFile(0)]);
				if (fault === "duplicate") return filesReply([planFile(0), planFile(0)]);
				if (fault === "unknown_state")
					return filesReply([
						{ ...planFile(0), expectedStateJson: { kind: "unknown" } },
						planFile(1),
					]);
				return reply({
					items: [planFile(0)],
					hasMore: true,
					nextCursor: { fileKey: "wrong-cursor" },
				});
			};
			await renderAction();
			assertUnavailable();
			expect(document.body.textContent).toContain(en.revertScopePreviewTruncated);
			expect(requestsTo("/files")).toHaveLength(1);
		});
	}

	test("the shared file count limit refuses loading an oversized plan", async () => {
		respond = () =>
			reply(preparedActionPreview({ expectedFileCount: FILE_CHANGE_LIMITS.revertFiles + 1 }));
		await renderAction();
		assertUnavailable();
		expect(document.body.textContent).toContain(en.revertScopeWindowTooLarge);
		expect(requestsTo("/files")).toHaveLength(0);
	});

	test("known unsupported block scope does not authorize deletion despite no conflicts", async () => {
		action = "delete_tool_block";
		respond = () =>
			reply({
				action,
				plan: null,
				executable: false,
				unavailable: "execution_unavailable",
				historySummary: null,
			});
		await renderAction();
		assertUnavailable();
		expect(document.body.textContent).toContain(en.revertScopeExecutionUnavailable);
		expect(document.body.textContent).not.toContain(en.blockDeleteConfirmNoFiles);
		expect(requestsTo("/files")).toHaveLength(0);
	});

	test("reload revokes the ready plan before its replacement request returns", async () => {
		respond = normalResponse;
		await renderAction();
		const replacement = deferredResponse();
		respond = () => replacement.promise;
		await click(button(en.revertPlanReload));
		assertUnavailable();
		expect(requestsTo("/revert-action-preview")).toHaveLength(2);
		pending = null;
		await renderAction();
		expect(requests.at(-1)?.signal?.aborted).toBe(true);
		replacement.resolve(reply(preparedActionPreview()));
	});

	test("preview opens over plain HTTP without crypto.randomUUID", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
		Object.defineProperty(globalThis.crypto, "randomUUID", {
			value: undefined,
			configurable: true,
		});
		try {
			respond = normalResponse;
			await renderAction();
			expect(button(en.rollbackConfirmWithRevert).disabled).toBe(false);
			expect(String(requests[0].body?.idempotencyKey).length).toBeGreaterThan(20);
		} finally {
			if (descriptor) Object.defineProperty(globalThis.crypto, "randomUUID", descriptor);
			else Reflect.deleteProperty(globalThis.crypto, "randomUUID");
		}
	});

	test("reopening the same target uses a new key and never exposes the old plan", async () => {
		const reopened = deferredResponse();
		respond = normalResponse;
		await renderAction();
		expect(button(en.rollbackConfirmWithRevert).disabled).toBe(false);
		const target = pending;
		pending = null;
		await renderAction();
		expect(requests[0].signal?.aborted).toBe(true);
		respond = (request) =>
			request.url.pathname.endsWith("/revert-action-preview")
				? reopened.promise
				: normalResponse(request);
		pending = target;
		await renderAction();
		assertUnavailable();
		const previews = requestsTo("/revert-action-preview");
		expect(previews).toHaveLength(2);
		expect(previews[0].body?.idempotencyKey).not.toBe(previews[1].body?.idempotencyKey);
		reopened.resolve(reply(preparedActionPreview({ id: "plan-2", planHash: "hash-plan-2" })));
		await flush();
		await click(button(en.rollbackConfirmWithRevert));
		expect(confirmations[0]?.revertPlan).toEqual({
			planId: "plan-2",
			planHash: "hash-plan-2",
			action,
		});
	});

	test("a late response for a different target is ignored and cancelled", async () => {
		const old = deferredResponse();
		respond = () => old.promise;
		await renderAction();
		const first = requests[0];
		pending = { messageId: "new-message", blockIndex: 7 };
		respond = (request) =>
			request.url.pathname.endsWith("/revert-action-preview")
				? reply(preparedActionPreview({ id: "new-plan", planHash: "new-hash" }))
				: normalResponse(request);
		await renderAction();
		expect(first.signal?.aborted).toBe(true);
		old.resolve(reply(preparedActionPreview()));
		await flush();
		await click(button(en.rollbackConfirmWithRevert));
		expect(confirmations[0]?.revertPlan?.planId).toBe("new-plan");
		expect(
			requestsTo("/files").every((request) => request.url.pathname.includes("/new-plan/")),
		).toBe(true);
	});

	test("expiration revokes confirmation without re-planning; reload creates a new preview", async () => {
		respond = (request) =>
			request.url.pathname.endsWith("/revert-action-preview")
				? reply(preparedActionPreview({ expiresAt: new Date(Date.now() + 180).toISOString() }))
				: normalResponse(request);
		await renderAction();
		expect(button(en.rollbackConfirmWithRevert).disabled).toBe(false);
		await waitFor(() => document.body.textContent?.includes(en.revertPlanExpired) === true);
		assertUnavailable();
		expect(requestsTo("/revert-action-preview")).toHaveLength(1);
		respond = (request) =>
			request.url.pathname.endsWith("/revert-action-preview")
				? reply(preparedActionPreview({ id: "fresh-plan", planHash: "fresh-hash" }))
				: normalResponse(request);
		await click(button(en.revertPlanReload));
		expect(button(en.rollbackConfirmWithRevert).disabled).toBe(false);
		expect(requestsTo("/revert-action-preview")).toHaveLength(2);
	});

	test("expiration cancels an unfinished page and its late result cannot authorize rollback", async () => {
		const page = deferredResponse();
		respond = (request) =>
			request.url.pathname.endsWith("/files")
				? page.promise
				: reply(preparedActionPreview({ expiresAt: new Date(Date.now() + 120).toISOString() }));
		await renderAction();
		await waitFor(() => document.body.textContent?.includes(en.revertPlanExpired) === true);
		expect(requestsTo("/files")[0].signal?.aborted).toBe(true);
		page.resolve(filesReply([planFile(0), planFile(1)]));
		await flush();
		assertUnavailable();
	});
});

describe("fixed plan apply and history-only branches", () => {
	test("history-only unknown success payload is a failure, not a successful deletion", async () => {
		execute = true;
		respond = (request) =>
			request.url.pathname.includes("/rollback/") ? reply({ ok: false }) : normalResponse(request);
		await renderAction();
		await click(button(props.messagesOnlyLabel));
		expect(applyErrors).toHaveLength(1);
		expect(requestsTo("/apply")).toHaveLength(0);
	});

	test("a lost apply response remains uncertain, without retry or legacy fallback", async () => {
		execute = true;
		respond = (request) => {
			if (request.url.pathname.endsWith("/apply")) throw new Error("fixture connection lost");
			return normalResponse(request);
		};
		await renderAction();
		await click(button(en.rollbackConfirmWithRevert));
		await flush();
		expect(applyErrors).toHaveLength(1);
		expect(requestsTo("/apply")).toHaveLength(1);
		expect(requestsTo("/revert-action-preview")).toHaveLength(1);
		expect(notificationsStore.getState().notifications.at(-1)?.message).toContain(
			en.revertPlanApplyFailed,
		);
		expect(
			requests.filter(
				(request) => request.method === "DELETE" || request.url.pathname.includes("/rollback/"),
			),
		).toHaveLength(0);
		assertUnavailable();
	});

	test("committed apply displays a returned warning without another history request", async () => {
		execute = true;
		respond = (request) =>
			request.url.pathname.endsWith("/apply")
				? reply({
						planId: "plan-1",
						status: "committed",
						journalStatus: "committed",
						settling: false,
						reason: "fixture advisory",
					})
				: normalResponse(request);
		await renderAction();
		await click(button(en.rollbackConfirmWithRevert));
		expect(applyErrors).toHaveLength(0);
		expect(notificationsStore.getState().notifications.at(-1)?.message).toBe("fixture advisory");
		expect(requests).toHaveLength(3);
	});

	for (const selectedAction of ["rollback_to_block", "delete_tool_block"] as const) {
		test(`${selectedAction} sends the reviewed plan once and does not delete history again`, async () => {
			action = selectedAction;
			execute = true;
			const apply = deferredResponse();
			respond = (request) =>
				request.url.pathname.endsWith("/apply") ? apply.promise : normalResponse(request);
			const resources = [
				"messages",
				"file-modifications",
				"file-diff",
				"file-tree-status",
				"tool-calls",
			];
			for (const resource of resources)
				queryClient.setQueryData(["narrators", "narrator-test", resource], {});
			await renderAction();
			await click(button(en.rollbackConfirmWithRevert));
			expect(requestsTo("/apply")).toHaveLength(1);
			expect(requestsTo("/apply")[0].url.pathname).toBe(
				"/api/narrators/narrator-test/revert-plans/plan-1/apply",
			);
			expect(requestsTo("/apply")[0].body).toEqual({ planHash: "hash-plan-1", action });
			expect(button(props.messagesOnlyLabel).disabled).toBe(true);
			expect(button(en.revertPlanReload).disabled).toBe(true);
			expect(button(en.cancel).disabled).toBe(true);
			apply.resolve(normalResponse(requestsTo("/apply")[0]));
			await flush();
			expect(applyErrors).toEqual([]);
			expect(
				requests.filter(
					(request) => request.method === "DELETE" || request.url.pathname.includes("/rollback/"),
				),
			).toHaveLength(0);
			for (const resource of resources) {
				expect(
					queryClient.getQueryState(["narrators", "narrator-test", resource])?.isInvalidated,
				).toBe(true);
			}
			assertUnavailable();
		});

		test(`${selectedAction} keep-files sends only the explicit legacy history operation`, async () => {
			action = selectedAction;
			execute = true;
			respond = normalResponse;
			await renderAction();
			await click(button(props.messagesOnlyLabel));
			expect(confirmations).toEqual([{ skipRevert: true }]);
			expect(requestsTo("/apply")).toHaveLength(0);
			const history = requests.at(-1);
			if (action === "rollback_to_block") {
				expect(history?.url.pathname).toBe("/api/narrators/narrator-test/rollback/message-1");
				expect(history?.body).toEqual({ blockIndex: 3, skipRevert: true });
			} else {
				expect(history?.method).toBe("DELETE");
				expect(history?.url.pathname).toBe(
					"/api/narrators/narrator-test/messages/message-1/blocks/3",
				);
				expect(history?.url.searchParams.get("skipRevert")).toBe("1");
			}
		});
	}

	for (const [status, explanation] of [
		["compensated", en.revertPlanCompensated],
		["recovery_required", en.revertPlanRecoveryRequired],
		["settling", en.revertPlanSettling],
		["runtime_reload_required", en.revertScopeRuntimeReloadRequired],
	]) {
		test(`${status} is not reported as successful and never retries apply or preview`, async () => {
			execute = true;
			respond = (request) =>
				request.url.pathname.endsWith("/apply")
					? reply(
							{
								planId: "plan-1",
								status: status === "settling" ? "recovery_required" : status,
								journalStatus: status === "settling" ? "applying" : status,
								settling: status === "settling",
								reason: "fixture journal reason",
								code:
									status === "runtime_reload_required"
										? "REVERT_RUNTIME_RELOAD_REQUIRED"
										: "REVERT_APPLY_NOT_COMMITTED",
							},
							409,
						)
					: normalResponse(request);
			await renderAction();
			await click(button(en.rollbackConfirmWithRevert));
			await flush();
			expect(applyErrors).toHaveLength(1);
			expect(requestsTo("/apply")).toHaveLength(1);
			expect(requestsTo("/revert-action-preview")).toHaveLength(1);
			expect(notificationsStore.getState().notifications.at(-1)?.message).toContain(explanation);
			expect(notificationsStore.getState().notifications.at(-1)?.message).toContain(
				"fixture journal reason",
			);
			assertUnavailable();
		});
	}
});

const reasonKeys = {
	no_boundaries: "revertScopeLegacyUnverified",
	snapshot_missing: "revertScopeSnapshotMissing",
	no_workspace: "revertScopeUnsupportedTarget",
	git_unsupported: "revertScopeUnsupportedTarget",
	window_too_large: "revertScopeWindowTooLarge",
	legacy_unverified: "revertScopeLegacyUnverified",
	execution_unavailable: "revertScopeExecutionUnavailable",
	runtime_reload_required: "revertScopeRuntimeReloadRequired",
	incomplete_coverage: "revertScopeIncompleteCoverage",
	unsupported_target: "revertScopeUnsupportedTarget",
	pending_operations: "revertScopePendingOperations",
	future_unknown_reason: "revertScopeUnavailable",
} as const;

for (const [language, locale] of Object.entries({ en, "zh-CN": zh })) {
	describe(`RevertScopeConfirmModal unavailable reasons (${language})`, () => {
		for (const [reason, key] of Object.entries(reasonKeys)) {
			test(`${reason} blocks rollback and explains the reason`, async () => {
				await i18n.changeLanguage(language);
				await render({
					data: completePreview({
						narratorScope: {
							// Even a contradictory available flag must not override a known
							// blocker or a reason from an unsupported future contract.
							available: true,
							reason: reason as ScopedRevertUnavailableReason,
							files: [],
							conflicts: [],
						},
					}),
				});
				assertUnavailable(locale);
				expect(document.body.textContent).toContain(locale[key]);
				expect(document.body.textContent).toContain(locale.revertScopeKeepFiles);
				await click(button(locale.revertScopeUnavailableTitle));
				expect(confirmations).toEqual([]);
				await click(button(props.messagesOnlyLabel));
				expect(confirmations).toEqual([{ skipRevert: true }]);
			});
		}
	});
}
