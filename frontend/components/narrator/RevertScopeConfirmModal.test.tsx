import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
	RevertScope,
	RevertScopePreviews,
	ScopedRevertUnavailableReason,
} from "@frontend/lib/api/narrators";
import { MantineProvider } from "@mantine/core";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import en from "../../locales/en/narrator.json";
import zh from "../../locales/zh-CN/narrator.json";
import {
	RevertScopeConfirmModal,
	type RevertScopeConfirmModalProps,
} from "./RevertScopeConfirmModal";

// No API or module mocks: render the real dialog and Mantine controls. The Bun
// preload isolates HOME/NARRAFORK_HOME before this frontend-only suite imports.
const i18n = i18next.createInstance();
let root: Root | undefined;
let props: RevertScopeConfirmModalProps;
let confirmations: Array<{ skipRevert: boolean; scope?: RevertScope }>;

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

function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
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
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		Document: window.Document,
		ShadowRoot: window.ShadowRoot,
		HTMLElement: window.HTMLElement,
		HTMLButtonElement: window.HTMLButtonElement,
		HTMLInputElement: window.HTMLInputElement,
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
	});
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
	await flush();
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

const reasonKeys = {
	no_boundaries: "revertScopeLegacyUnverified",
	snapshot_missing: "revertScopeSnapshotMissing",
	no_workspace: "revertScopeUnsupportedTarget",
	git_unsupported: "revertScopeUnsupportedTarget",
	window_too_large: "revertScopeWindowTooLarge",
	legacy_unverified: "revertScopeLegacyUnverified",
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
