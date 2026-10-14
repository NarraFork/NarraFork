import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { LegacyMigrationPreview, LegacyMigrationResult } from "../../lib/api/legacy-migration";

const migrate = mock((_revision: string) => {});
const disable = mock(() => {});
const refetch = mock(async () => {});
let canManage = true;
let accessError: { status?: number } | null = null;
let receiptFlag = false;
let preview: LegacyMigrationPreview;
let result: LegacyMigrationResult | undefined;
let error: Error | null;
let stopped = false;
let openedFlag = false;
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@mantine/core", () => ({
	Alert: box,
	Group: box,
	Stack: box,
	Text: box,
	Title: box,
	Loader: () => <div>loading</div>,
	Button: ({
		children,
		disabled,
		onClick,
	}: {
		children?: ReactNode;
		disabled?: boolean;
		onClick?: () => void;
	}) => (
		<button type="button" disabled={disabled} onClick={onClick}>
			{children}
		</button>
	),
	Drawer: ({ opened, children }: { opened: boolean; children?: ReactNode }) => (
		<div hidden={!opened}>{children}</div>
	),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@tanstack/react-router", () => ({ Link: box }));
mock.module("../../hooks/useProjectAccess", () => ({
	useProjectAccess: () => ({ data: { canManage }, isError: !!accessError, error: accessError }),
}));
mock.module("../../hooks/useMobileDrawerHistory", () => ({ useMobileDrawerHistory: () => {} }));
mock.module("../../hooks/useLegacyMigration", () => ({
	useLegacyMigration: (
		_id: string,
		opened: boolean,
		_canManage: boolean,
		allowReceiptLookup = false,
	) => {
		openedFlag = opened;
		receiptFlag = allowReceiptLookup;
		return {
			preview: {
				data: preview,
				error,
				isError: !!error,
				isFetching: false,
				isFetchedAfterMount: true,
				refetch,
			},
			migration: { data: result, mutate: migrate, reset: () => {} },
			disable: { mutate: disable, reset: () => {} },
			draining: false,
			syncDisabled: stopped,
		};
	},
}));
const { LegacyMigrationContent, LegacyMigrationAssistant } = await import(
	"./LegacyMigrationAssistant"
);
let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	preview = {
		projectId: "p",
		projectName: "legacy",
		syncDisabled: false,
		phase: "none",
		canMigrate: true,
		narratorCount: 2,
		chapterCount: 3,
		blockers: [],
		revision: "rev-1",
	};
	result = undefined;
	error = null;
	stopped = false;
	canManage = true;
	accessError = null;
	receiptFlag = false;
	migrate.mockClear();
	disable.mockClear();
	refetch.mockClear();
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
});
async function renderContent(permission = true) {
	await act(async () =>
		root.render(<LegacyMigrationContent projectId="p" opened canManage={permission} />),
	);
}
async function click(label: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(b) => b.textContent === label,
	);
	expect(button).toBeDefined();
	if (!button?.disabled)
		await act(async () => button?.dispatchEvent(new window.Event("click", { bubbles: true })));
}
test("opening, closing and first action never mutate; only explicit confirmation submits revision", async () => {
	await renderContent();
	expect(migrate).not.toHaveBeenCalled();
	expect(disable).not.toHaveBeenCalled();
	await click("migration.action");
	expect(container.textContent).toContain("migration.confirmMigration");
	expect(container.textContent).toContain("migration.preserve");
	expect(container.textContent).toContain("migration.remove");
	expect(migrate).not.toHaveBeenCalled();
	await click("migration.cancel");
	expect(migrate).not.toHaveBeenCalled();
	await click("migration.action");
	await click("migration.confirm");
	expect(migrate).toHaveBeenCalledTimes(1);
	expect(migrate).toHaveBeenCalledWith("rev-1");
});
test("blocked reason is concrete and stopping sync is independently confirmed", async () => {
	preview.canMigrate = false;
	preview.phase = "blocked";
	preview.blockers = [{ code: "running", message: "Wait for narrator n to become idle" }];
	await renderContent();
	expect(container.textContent).toContain("Wait for narrator n to become idle");
	await click("migration.action");
	expect(migrate).not.toHaveBeenCalled();
	await click("migration.disableSync");
	expect(disable).not.toHaveBeenCalled();
	await click("migration.confirm");
	expect(disable).toHaveBeenCalledTimes(1);
});
test("stopped sync cannot be disabled again and stale revision cannot execute", async () => {
	stopped = true;
	await renderContent();
	await click("migration.syncDisabled");
	expect(disable).not.toHaveBeenCalled();
	await click("migration.action");
	preview = { ...preview, revision: "rev-2" };
	await renderContent();
	await click("migration.confirm");
	expect(migrate).not.toHaveBeenCalled();
});
test("permission gate hides complete preview and blocks every action", async () => {
	await renderContent(false);
	expect(container.textContent).toContain("migration.manageRequired");
	expect(container.textContent).not.toContain("legacy");
	expect(container.querySelector("button")).toBeNull();
});
test("completed response survives project 404 and permission refresh failure without refetch", async () => {
	result = { phase: "completed", narratorIds: ["n"], syncDisabled: true };
	error = new Error("404 project removed");
	await renderContent(false);
	expect(container.textContent).toContain("migration.phase.completed");
	expect(container.textContent).toContain("migration.openNarrator");
	expect(container.textContent).not.toContain("migration.action");
	expect(refetch).not.toHaveBeenCalled();
});
test("narrator late association opens once; disappearing association retains result source", async () => {
	await act(async () => root.render(<LegacyMigrationAssistant autoOpen />));
	expect(container.textContent).toBe("");
	await act(async () => root.render(<LegacyMigrationAssistant projectId="p" autoOpen />));
	expect(openedFlag).toBe(true);
	expect(migrate).not.toHaveBeenCalled();
	await act(async () => root.render(<LegacyMigrationAssistant autoOpen />));
	expect(container.textContent).toContain("migration.entry");
});
test("fresh project 404 recovers authorized completed preview and retained links without management access", async () => {
	canManage = false;
	accessError = { status: 404 };
	preview = { ...preview, phase: "completed", narratorIds: ["retained"] };
	await act(async () => root.render(<LegacyMigrationAssistant projectId="p" autoOpen />));
	expect(container.textContent).toContain("migration.phase.completed");
	expect(container.textContent).toContain("migration.openNarrator");
	expect(container.textContent).not.toContain("migration.manageRequired");
	expect(migrate).not.toHaveBeenCalled();
	expect(disable).not.toHaveBeenCalled();
});
test.each([
	401, 403, 500,
])("permission error %i cannot probe receipts or reveal a cached completed preview", async (status) => {
	canManage = false;
	accessError = { status };
	preview = { ...preview, phase: "completed", narratorIds: ["secret"] };
	await act(async () => root.render(<LegacyMigrationAssistant projectId="p" autoOpen />));
	expect(receiptFlag).toBe(false);
	expect(container.textContent).not.toContain("migration.phase.completed");
	expect(container.textContent).not.toContain("migration.openNarrator");
});
test("project 404 followed by receipt 403 hides stale completed data", async () => {
	canManage = false;
	accessError = { status: 404 };
	error = new Error("403 receipt denied");
	preview = { ...preview, phase: "completed", narratorIds: ["secret"] };
	await act(async () => root.render(<LegacyMigrationAssistant projectId="p" autoOpen />));
	expect(receiptFlag).toBe(true);
	expect(container.textContent).toContain("403 receipt denied");
	expect(container.textContent).not.toContain("migration.phase.completed");
	expect(container.textContent).not.toContain("migration.openNarrator");
	expect(migrate).not.toHaveBeenCalled();
	expect(disable).not.toHaveBeenCalled();
});
test("read-only pending receipt cannot expose migration controls", async () => {
	canManage = false;
	accessError = { status: 404 };
	preview.phase = "cleanup_pending";
	await act(async () => root.render(<LegacyMigrationAssistant projectId="p" autoOpen />));
	expect(receiptFlag).toBe(true);
	expect(container.textContent).toContain("migration.manageRequired");
	expect(container.textContent).not.toContain("migration.retryCleanup");
	expect(migrate).not.toHaveBeenCalled();
	expect(disable).not.toHaveBeenCalled();
});
test("cleanup pending shows blockers and keeps an explicitly confirmed retry action", async () => {
	result = {
		phase: "cleanup_pending",
		narratorIds: ["n"],
		syncDisabled: true,
		blockers: [{ code: "db_cleanup", message: "File locked" }],
	};
	preview = { ...preview, phase: "cleanup_pending", revision: "cleanup-r" };
	await renderContent();
	expect(container.textContent).toContain("File locked");
	await click("migration.retryCleanup");
	expect(migrate).not.toHaveBeenCalled();
	await click("migration.confirm");
	expect(migrate).toHaveBeenCalledWith("cleanup-r");
});
test("errors are surfaced and prevent migration using stale preview", async () => {
	error = new Error("revision mismatch");
	await renderContent();
	expect(container.textContent).toContain("revision mismatch");
	await click("migration.action");
	expect(migrate).not.toHaveBeenCalled();
});
