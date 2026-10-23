import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { WorkspaceContext } from "@shared/workspace-context";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";
import type {
	WorkspaceSnapshotRestorePreview,
	WorkspaceSnapshotRestoreRequest,
	WorkspaceSnapshotSummary,
} from "../../../lib/api/workspace-snapshot-restores";

const keys = [
	"window",
	"document",
	"navigator",
	"localStorage",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
const storageValues = new Map<string, string>();
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: {
		getItem: (key: string) => storageValues.get(key) ?? null,
		setItem: (key: string, value: string) => {
			storageValues.set(key, value);
		},
		removeItem: (key: string) => {
			storageValues.delete(key);
		},
	},
});
let context: WorkspaceContext = {
	revision: 12,
	deviceId: "current-device",
	cwd: "/current-cwd-lure",
	pathFlavor: "posix",
	contextKey: "current-view",
	capabilities: { switchDirectory: true },
};
const snapshot: WorkspaceSnapshotSummary = {
	id: "s".repeat(21),
	deviceId: "original-device",
	root: "D:\\original root",
	rootIdentity: "original-object",
	treeDigest: "a".repeat(64),
	sourceInstanceId: "original-source",
	scopeId: "original-scope",
	contextKey: "old-context",
	workspaceRevision: 3,
	originProjectId: null,
	originContextVersion: 1,
	state: "complete",
	edge: "before",
	createdAt: new Date().toISOString(),
	restorableCandidate: true,
};
function previewValue(): WorkspaceSnapshotRestorePreview {
	return {
		plan: {
			id: "p".repeat(21),
			planHash: "b".repeat(64),
			status: "prepared",
			coverageComplete: true,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		},
		origin: {
			captureId: snapshot.id,
			deviceId: snapshot.deviceId,
			root: snapshot.root as string,
			rootIdentity: snapshot.rootIdentity as string,
			treeDigest: snapshot.treeDigest as string,
			sourceInstanceId: snapshot.sourceInstanceId as string,
			scopeId: snapshot.scopeId,
			contextKey: snapshot.contextKey as string,
			workspaceRevision: 3,
			originProjectId: null,
			originContextVersion: 1,
		},
		confirmation: {
			kind: "snapshot_restore",
			captureId: snapshot.id,
			deviceId: snapshot.deviceId,
			root: snapshot.root as string,
			rootIdentity: snapshot.rootIdentity as string,
			treeDigest: snapshot.treeDigest as string,
		},
		requiresExplicitSnapshotRestore: true,
		files: [
			{ deviceId: snapshot.deviceId, path: "D:\\original root\\file.txt", willBeDeleted: false },
		],
		totalFileCount: 101,
		hasMore: true,
	};
}
const list = mock(async () => ({ items: [snapshot], nextCursor: null }));
const preview = mock(async () => previewValue());
const apply = mock(async (_id: string, input: WorkspaceSnapshotRestoreRequest) => ({
	planId: input.planId,
	status: "committed" as const,
	restoredFileCount: 101,
}));
const recover = mock(async (_id: string, input: WorkspaceSnapshotRestoreRequest) => ({
	planId: input.planId,
	status: "committed" as const,
	restoredFileCount: 101,
}));
mock.module("../../../lib/api/workspace-snapshot-restores", () => ({
	workspaceSnapshotRestoreApi: { list, preview, apply, recover },
}));
mock.module("../../../hooks/useAuth", () => ({
	useCurrentUser: () => ({ data: { id: "actor", role: "user" } }),
}));
mock.module("../../../hooks/useWorkspaceContext", () => ({
	useWorkspaceContext: () => ({ data: context }),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, options?: Record<string, unknown>) =>
			options ? `${key}:${JSON.stringify(options)}` : key,
	}),
}));
const Wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@mantine/core", () => ({
	Alert: Wrapper,
	Badge: Wrapper,
	Code: Wrapper,
	Divider: Wrapper,
	Group: Wrapper,
	Loader: Wrapper,
	ScrollArea: Wrapper,
	Stack: Wrapper,
	Text: Wrapper,
	Modal: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div>{children}</div> : null,
	Button: ({
		children,
		onClick,
		disabled,
	}: {
		children?: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
	}) => (
		<button type="button" onClick={onClick} disabled={disabled}>
			{children}
		</button>
	),
	Checkbox: ({
		checked,
		disabled,
		onChange,
		label,
	}: {
		checked: boolean;
		disabled: boolean;
		onChange: (event: import("react").FormEvent<HTMLInputElement>) => void;
		label: string;
	}) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={() => {}}
				onInput={onChange}
			/>
			{label}
		</label>
	),
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { WorkspaceSnapshotRestoreModal } = await import("./WorkspaceSnapshotRestoreModal");
let root: Root, host: HTMLElement, client: InstanceType<typeof QueryClient>;
const close = mock(() => {});
async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
	storageValues.clear();
	list.mockClear();
	preview.mockClear();
	apply.mockClear();
	recover.mockClear();
	close.mockClear();
	context = { ...context, revision: 12, contextKey: "current-view" };
	list.mockImplementation(async () => ({ items: [snapshot], nextCursor: null }));
	preview.mockImplementation(async () => previewValue());
	apply.mockImplementation(async (_id, input) => ({
		planId: input.planId,
		status: "committed",
		restoredFileCount: 101,
	}));
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	host.remove();
});
afterAll(() => {
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});
async function mount(opened = true) {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<WorkspaceSnapshotRestoreModal narratorId="n" opened={opened} onClose={close} />
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		await flush();
	});
}
function button(key: string) {
	const value = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
		(item) => item.textContent === key,
	);
	if (!value) throw new Error(`button missing ${key}`);
	return value;
}
async function click(key: string) {
	await act(async () => {
		button(key).click();
		await flush();
	});
}
async function consent() {
	await act(async () => {
		const input = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
		if (!input) throw new Error("checkbox missing");
		input.checked = true;
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
async function prepared() {
	await mount();
	await click("snapshotRestore.select");
	await click("snapshotRestore.preview");
}
test("actual modal shows full original scope, bounded diff warning and requires checkbox before exact apply", async () => {
	await prepared();
	expect(host.textContent).toContain(snapshot.root as string);
	expect(host.textContent).toContain(snapshot.treeDigest as string);
	expect(host.textContent).not.toContain("/current-cwd-lure");
	expect(host.textContent).toContain("snapshotRestore.diffTruncated");
	expect(button("snapshotRestore.apply").disabled).toBe(true);
	expect(apply).not.toHaveBeenCalled();
	await consent();
	await click("snapshotRestore.apply");
	expect(apply.mock.calls[0]?.[1]).toEqual({
		planId: "p".repeat(21),
		planHash: "b".repeat(64),
		confirmation: previewValue().confirmation,
	});
});
test("partial restore displays restored, conflicting and uncovered ranges", async () => {
	apply.mockImplementation(async (_id, input) => ({
		planId: input.planId,
		status: "committed" as const,
		restoredFileCount: 1,
		coverage: {
			restoredFiles: ["restored.txt"],
			conflicts: [{ path: "external.txt", reason: "current_state_mismatch" }],
			unknownCoverage: [{ root: "D:\\original root", reason: "untracked_bash" }],
		},
	}));
	await prepared();
	await consent();
	await click("snapshotRestore.apply");
	expect(host.textContent).toContain("partialRevert.restored");
	expect(host.textContent).toContain("partialRevert.conflicts");
	expect(host.textContent).toContain("external.txt");
	expect(host.textContent).toContain("current_state_mismatch");
	expect(host.textContent).toContain("partialRevert.unknown");
	expect(host.textContent).toContain("untracked_bash");
});
test("view revision change clears checked consent and leaves destructive action disabled", async () => {
	await prepared();
	await consent();
	expect(button("snapshotRestore.apply").disabled).toBe(false);
	context = { ...context, revision: 13, contextKey: "new-view" };
	await mount();
	expect(host.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked ?? false).toBe(
		false,
	);
	expect(button("snapshotRestore.apply").disabled).toBe(true);
	expect(apply).not.toHaveBeenCalled();
});
test("unknown network outcome survives close/reopen and recovery keeps original hash/root without new apply", async () => {
	apply.mockRejectedValue(new Error("reply lost"));
	await prepared();
	await consent();
	await click("snapshotRestore.apply");
	expect(host.textContent).toContain("snapshotRestore.pendingOriginal");
	expect(storageValues.size).toBe(1);
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<span>closed</span>
			</QueryClientProvider>,
		),
	);
	context = { ...context, revision: 99, contextKey: "elsewhere" };
	await mount();
	expect(button("snapshotRestore.recover").disabled).toBe(true);
	expect(host.textContent).toContain(snapshot.root as string);
	await consent();
	await click("snapshotRestore.recover");
	expect(recover.mock.calls[0]?.[1].confirmation).toEqual(previewValue().confirmation);
	expect(apply).toHaveBeenCalledTimes(1);
	expect(storageValues.size).toBe(0);
});
test("legacy or incomplete catalogue is not represented as restorable", async () => {
	list.mockImplementation(async () => ({
		items: [
			{
				...snapshot,
				originContextVersion: null,
				restorableCandidate: false,
				reason: "legacy_origin_unknown",
			},
		],
		nextCursor: null,
	}));
	await mount();
	expect(button("snapshotRestore.select").disabled).toBe(true);
	expect(host.textContent).toContain("snapshotRestore.legacyUnknown");
	expect(preview).not.toHaveBeenCalled();
});
