import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type {
	WorktreeCreateRequest,
	WorktreeCreateResult,
	WorktreeEntry,
	WorktreePrepareRequest,
} from "@shared/narrator-worktrees";
import type { WorkspaceContext } from "@shared/workspace-context";
import { parseHTML } from "linkedom";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});
const context: WorkspaceContext = {
	revision: 2,
	deviceId: "local",
	cwd: "/repo",
	pathFlavor: "posix",
	contextKey: "ctx",
	git: { workspaceKey: "wk", repositoryKey: "rk", rootPath: "/repo" },
	capabilities: { switchDirectory: true },
};
let activeContext: WorkspaceContext = context;
let activeUser: { id: string } | undefined = { id: "u1" };
const storage = new Map<string, string>();
let quotaFailure = false;
Object.defineProperty(window, "localStorage", {
	value: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => {
			if (quotaFailure) throw new Error("quota");
			storage.set(key, value);
		},
	},
	configurable: true,
});
mock.module("@frontend/hooks/useAuth", () => ({ useCurrentUser: () => ({ data: activeUser }) }));
const switched = mock(async (_input: unknown) => ({
	current: context,
	previous: context,
	changed: true,
}));
const prepare = mock(async (_id: string, _input: unknown) => ({
	branchName: "named",
	worktreeName: "named",
	destinationPath: "/wt/named",
}));
const created = (path = "/wt/named"): WorktreeCreateResult => ({
	outcome: "created",
	worktree: {
		path,
		head: null,
		branch: "refs/heads/named",
		detached: false,
		locked: false,
		prunable: false,
	},
	residuals: { destinationExists: true, branchExists: true },
});
const create = mock(
	async (_id: string, input: unknown): Promise<WorktreeCreateResult> =>
		created((input as WorktreeCreateRequest).destinationPath),
);
const reconcile = mock(
	async (_id: string, input: unknown): Promise<WorktreeCreateResult> =>
		created((input as WorktreeCreateRequest).destinationPath),
);
mock.module("@frontend/hooks/useWorkspaceContext", () => ({
	useWorkspaceContext: () => ({ data: activeContext }),
	useSwitchWorkspaceContext: () => ({ mutateAsync: switched, isPending: false }),
}));
class FakeApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}
mock.module("@frontend/lib/api", () => ({
	api: {
		prepareNarratorWorktree: prepare,
		createNarratorWorktree: create,
		reconcileNarratorWorktree: reconcile,
		listNarratorWorktrees: async () => ({ entries: [] }),
	},
	ApiError: FakeApiError,
}));
let listEntries: WorktreeEntry[] = [];
const refetch = mock(async () => {});
mock.module("@tanstack/react-query", () => ({
	useQuery: () => ({
		data: { entries: listEntries, capabilities: { create: true } },
		isPending: false,
		refetch,
	}),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
type Children = { children?: ReactNode };
const Wrapper = ({ children }: Children) => <div>{children}</div>;
mock.module("@mantine/core", () => {
	const Menu = Object.assign(Wrapper, {
		Target: Wrapper,
		Dropdown: Wrapper,
		Label: Wrapper,
		Item: ({
			children,
			onClick,
			disabled,
		}: Children & { onClick?: () => void; disabled?: boolean }) => (
			<button type="button" disabled={disabled} onClick={onClick}>
				{children}
			</button>
		),
	});
	return {
		Group: Wrapper,
		Stack: Wrapper,
		Text: Wrapper,
		Alert: Wrapper,
		Loader: () => <span>loader</span>,
		Tooltip: Wrapper,
		Menu,
		Badge: Wrapper,
		ScrollArea: { Autosize: Wrapper },
		Select: ({
			label,
			value,
			data,
			onChange,
		}: {
			label: string;
			value: string;
			data: { value: string; label: string }[];
			onChange: (value: string) => void;
		}) => (
			<select
				aria-label={label}
				value={value}
				onChange={(event) => onChange(event.currentTarget.value)}
			>
				{data.map((option) => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		),
		Modal: ({ opened, children }: Children & { opened: boolean }) =>
			opened ? <div data-modal>{children}</div> : null,
		Collapse: ({ expanded, children }: Children & { expanded: boolean }) =>
			expanded ? <div data-advanced>{children}</div> : null,
		ActionIcon: ({
			children,
			onClick,
			disabled,
			"aria-label": label,
		}: Children & { onClick?: () => void; disabled?: boolean; "aria-label"?: string }) => (
			<button type="button" aria-label={label} disabled={disabled} onClick={onClick}>
				{children}
			</button>
		),
		Button: ({
			children,
			onClick,
			disabled,
			type,
			"data-worktree-path": path,
		}: Children & {
			onClick?: () => void;
			disabled?: boolean;
			type?: "submit" | "button";
			"data-worktree-path"?: string;
		}) => (
			<button
				type={type ?? "button"}
				disabled={disabled}
				onClick={onClick}
				data-worktree-path={path}
			>
				{children}
			</button>
		),
		TextInput: ({
			label,
			value,
			onChange,
			disabled,
		}: {
			label: string;
			value: string;
			onChange: (event: unknown) => void;
			disabled?: boolean;
		}) => <input aria-label={label} value={value} disabled={disabled} onInput={onChange} />,
		Textarea: ({
			label,
			value,
			onChange,
			disabled,
		}: {
			label: string;
			value: string;
			onChange: (event: unknown) => void;
			disabled?: boolean;
		}) => <textarea aria-label={label} value={value} disabled={disabled} onInput={onChange} />,
	};
});
mock.module("../../common/DirectoryPicker", () => ({
	DirectoryPicker: ({ onChange, mode }: { onChange: (path: string) => void; mode?: string }) => (
		<div data-unified-directory-picker data-mode={mode}>
			<button type="button" onClick={() => onChange("/repo/custom-new")}>
				picker-select-custom
			</button>
		</div>
	),
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NarratorWorktreeControls } = await import("./NarratorWorktreeControls");
let root: Root;
let container: HTMLElement;
async function flush() {
	for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function click(label: string) {
	const button = [
		...container.querySelectorAll<HTMLButtonElement>("form button"),
		...container.querySelectorAll("button"),
	].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
	expect(button).toBeDefined();
	await act(async () => {
		button?.click();
		await flush();
	});
}
async function openForm() {
	await click("worktree.quickCreate");
}
async function input(label: string, value: string) {
	const field = container.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
	await act(async () => {
		field.value = value;
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
async function submit() {
	await act(async () => {
		container
			.querySelector("form")
			?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
		await flush();
	});
}
beforeEach(async () => {
	activeContext = context;
	listEntries = [];
	refetch.mockClear();
	activeUser = { id: "u1" };
	storage.clear();
	quotaFailure = false;
	prepare.mockClear();
	create.mockClear();
	reconcile.mockClear();
	switched.mockClear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(<NarratorWorktreeControls narratorId="n" />);
		await flush();
	});
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});
afterAll(() => {
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});

test("switch dialog refreshes, searches, sorts and closes after a successful switch", async () => {
	listEntries = [
		{
			...created("/repo/older").worktree,
			branch: "refs/heads/older",
			lastCommitAt: 100,
			createdAt: 300,
		},
		{
			...created("/repo/newer").worktree,
			branch: "refs/heads/newer",
			lastCommitAt: 200,
			createdAt: 50,
		},
	] as WorktreeEntry[];
	await click("worktree.switch");
	expect(refetch).toHaveBeenCalledTimes(1);
	const paths = () =>
		[...container.querySelectorAll("[data-worktree-path]")].map((node) =>
			node.getAttribute("data-worktree-path"),
		);
	expect(paths()).toEqual(["/repo/newer", "/repo/older"]);
	await click("worktree.descending");
	expect(paths()).toEqual(["/repo/older", "/repo/newer"]);
	await input("worktree.search", "NEWER");
	expect(paths()).toEqual(["/repo/newer"]);
	await input("worktree.search", "not-there");
	expect(paths()).toEqual([]);
	expect(container.textContent).toContain("worktree.noMatches");
	await input("worktree.search", "");
	await act(async () => {
		const select = container.querySelector("select");
		if (!select) throw new Error("Missing sort selector");
		// linkedom's select value is read-only; override to emulate a browser change.
		Object.defineProperty(select, "value", { configurable: true, value: "createdAt" });
		select.dispatchEvent(new window.Event("change", { bubbles: true }));
	});
	expect(paths()).toEqual(["/repo/older", "/repo/newer"]);
	expect(container.textContent).toContain("worktree.createdTimeHint");
	await act(async () => {
		container.querySelector<HTMLButtonElement>('[data-worktree-path="/repo/newer"]')?.click();
		await flush();
	});
	expect(switched.mock.calls[0]?.[0]).toMatchObject({
		target: { cwd: "/repo/newer", deviceId: "local" },
	});
	expect(container.querySelector("[data-modal]")).toBeNull();
});

test("switch dialog shows an empty state", async () => {
	await click("worktree.switch");
	expect(container.textContent).toContain("worktree.emptyList");
});

test("advanced is collapsed and expands the existing unified DirectoryPicker", async () => {
	await openForm();
	expect(container.querySelector("[data-advanced]")).toBeNull();
	await click("worktree.advanced");
	expect(
		container.querySelector("[data-unified-directory-picker]")?.getAttribute("data-mode"),
	).toBe("newTarget");
});
test("empty submit stays in the form and invokes no naming/create endpoint", async () => {
	await openForm();
	await submit();
	expect(container.textContent).toContain("worktree.empty");
	expect(prepare).not.toHaveBeenCalled();
	expect(create).not.toHaveBeenCalled();
});
test.each([
	["worktree.name", "fix", "name"],
	["worktree.requirement", "fix auth", "requirement"],
])("%s only submits directly through prepare/create/switch", async (label, value, key) => {
	await openForm();
	await input(label, value);
	await submit();
	expect(prepare).toHaveBeenCalledTimes(1);
	expect(prepare.mock.calls[0]?.[1]).toMatchObject({ [key]: value });
	expect(create).toHaveBeenCalledTimes(1);
	expect(switched).toHaveBeenCalledTimes(1);
	expect(container.querySelector("[data-modal]")).toBeNull();
});
test.each([
	["worktree.name", "HTTP name only", "name"],
	["worktree.requirement", "HTTP requirement only", "requirement"],
])("plaintext HTTP without crypto.subtle: %s prepares, persists before dispatch, and creates", async (label, value, key) => {
	const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
	const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
	Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues } });
	try {
		expect(globalThis.crypto.subtle).toBeUndefined();
		expect(typeof globalThis.crypto.getRandomValues).toBe("function");
		create.mockImplementationOnce(async (_id, request) => {
			const receipt = JSON.parse([...storage.values()][0] ?? "[]")[0];
			expect(receipt.request).toEqual(request);
			expect(receipt.scope).toEqual({
				userId: "u1",
				narratorId: "n",
				deviceId: "local",
				repositoryKey: "rk",
			});
			expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
			expect([...storage.values()].join("")).not.toContain(value);
			return created((request as WorktreeCreateRequest).destinationPath);
		});
		await openForm();
		await input(label, value);
		await submit();
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(prepare.mock.calls[0]?.[1]).toMatchObject({ [key]: value });
		expect(create).toHaveBeenCalledTimes(1);
		expect(switched).toHaveBeenCalledTimes(1);
		expect(container.textContent).not.toContain("worktree.receiptStorage");
		expect(container.querySelector("[data-modal]")).toBeNull();
	} finally {
		if (original) Object.defineProperty(globalThis, "crypto", original);
		else Reflect.deleteProperty(globalThis, "crypto");
	}
});
test("a successful switch retains the requirement as a composer prompt exactly once", async () => {
	const retained = mock((_text: string) => {});
	await act(async () =>
		root.render(<NarratorWorktreeControls narratorId="n" onRequirement={retained} />),
	);
	await openForm();
	await input("worktree.requirement", "fix login");
	await submit();
	expect(retained).toHaveBeenCalledTimes(1);
	expect(retained.mock.calls[0]?.[0]).toBe("fix login");
});
test("return to original directory freezes the original device and sends the latest revision", async () => {
	activeContext = { ...context, cwd: "/wt/named", revision: 3, contextKey: "new" };
	await act(async () => root.render(<NarratorWorktreeControls narratorId="n" />));
	await click("worktree.switch");
	expect(container.textContent).toContain("named");
	await click("worktree.returnOriginal: repo");
	expect(switched.mock.calls[0]?.[0]).toMatchObject({
		expectedRevision: 3,
		target: { deviceId: "local", cwd: "/repo" },
	});
});
test("busy switch 409 keeps the form and worktree, then retries only switching", async () => {
	switched.mockRejectedValueOnce(new FakeApiError("busy", 409));
	await openForm();
	await input("worktree.name", "fix");
	await submit();
	expect(container.textContent).toContain("worktree.busy");
	expect(container.textContent).toContain("worktree.createdSwitchFailed");
	expect(container.querySelector("[data-modal]")).not.toBeNull();
	await click("worktree.retrySwitch");
	expect(switched).toHaveBeenCalledTimes(2);
	expect(create).toHaveBeenCalledTimes(1);
	expect(container.querySelector("[data-modal]")).toBeNull();
});
test("unknown creation outcome disables blind create retries and offers inspection", async () => {
	create.mockRejectedValueOnce(new Error("Network unavailable"));
	await openForm();
	await input("worktree.name", "fix");
	await submit();
	expect(container.textContent).toContain("worktree.unknown");
	expect(container.textContent).toContain("worktree.inspectExisting");
	await submit();
	expect(create).toHaveBeenCalledTimes(1);
	expect(switched).not.toHaveBeenCalled();
});
test.each([
	"branch",
	"destination",
])("advanced %s reaches prepare and avoids unused-default collision", async (kind) => {
	prepare.mockImplementationOnce(async (_id, value) => {
		const input = value as WorktreePrepareRequest;
		if (
			(kind === "branch" && !input.branchName) ||
			(kind === "destination" && !input.destinationPath)
		)
			throw new Error("default collision");
		return {
			branchName: input.branchName ?? "fix",
			worktreeName: "fix",
			destinationPath: input.destinationPath ?? "/repo/fix-2",
		};
	});
	await openForm();
	await input("worktree.name", "fix");
	await click("worktree.advanced");
	if (kind === "branch") await input("worktree.branchOverride", "fix-2");
	else await click("picker-select-custom");
	await submit();
	expect(prepare.mock.calls[0]?.[1]).toMatchObject(
		kind === "branch" ? { branchName: "fix-2" } : { destinationPath: "/repo/custom-new" },
	);
	expect(create).toHaveBeenCalledTimes(1);
	expect(switched).toHaveBeenCalledTimes(1);
});
test("unknown creation verifies the original receipt, then only switches", async () => {
	create.mockRejectedValueOnce(new Error("lost response"));
	await openForm();
	await input("worktree.name", "fix");
	await submit();
	const original = create.mock.calls[0]?.[1];
	await click("worktree.verify");
	expect(reconcile.mock.calls[0]?.[1]).toEqual(original);
	expect(create).toHaveBeenCalledTimes(1);
	expect(switched).not.toHaveBeenCalled();
	expect(container.textContent).toContain("worktree.verifiedCreated");
	await click("worktree.continueSwitch");
	expect(switched).toHaveBeenCalledTimes(1);
	expect(create).toHaveBeenCalledTimes(1);
});
test("still-unknown verification cannot unlock creation; verified failure can", async () => {
	create.mockRejectedValueOnce(new Error("lost response"));
	reconcile.mockResolvedValueOnce({
		outcome: "unknown",
		worktree: null,
		residuals: { destinationExists: null, branchExists: null },
	});
	await openForm();
	await input("worktree.name", "fix");
	await submit();
	await click("worktree.verify");
	await submit();
	expect(create).toHaveBeenCalledTimes(1);
	expect(container.textContent).toContain("worktree.unknown");
	reconcile.mockResolvedValueOnce({
		outcome: "failed",
		worktree: null,
		residuals: { destinationExists: false, branchExists: false },
		error: { code: "FAILED", message: "creation failed" },
	});
	await click("worktree.verify");
	await input("worktree.name", "fix-2");
	await submit();
	expect(create).toHaveBeenCalledTimes(2);
	expect((create.mock.calls[0]?.[1] as WorktreeCreateRequest).requestId).not.toBe(
		(create.mock.calls[1]?.[1] as WorktreeCreateRequest).requestId,
	);
});
test("manual context switch frees a blank form but retains exact old receipt for cross-revision recovery", async () => {
	create.mockRejectedValueOnce(new Error("lost response"));
	await openForm();
	await input("worktree.requirement", "repair old task");
	await submit();
	const original = create.mock.calls[0]?.[1];
	activeContext = {
		...context,
		revision: 7,
		cwd: "/wt/named",
		contextKey: "new-context",
		git: { repositoryKey: "rk", rootPath: "/wt/named", workspaceKey: "new-key" },
	};
	await act(async () => {
		root.render(<NarratorWorktreeControls narratorId="n" />);
		await flush();
	});
	expect(container.querySelector("[data-modal]")).toBeNull();
	await openForm();
	expect((container.querySelector('[aria-label="worktree.name"]') as HTMLInputElement).value).toBe(
		"",
	);
	expect(
		(container.querySelector('[aria-label="worktree.requirement"]') as HTMLTextAreaElement).value,
	).toBe("");
	expect(container.textContent).toContain("worktree.pendingNotice");
	expect(create).toHaveBeenCalledTimes(1);
	await click("worktree.inspectExisting");
	await click("worktree.pendingAttempt: /wt/named");
	expect(reconcile.mock.calls[0]?.[1]).toEqual(original);
	expect((reconcile.mock.calls[0]?.[1] as WorktreeCreateRequest).expectedRevision).toBe(2);
	await click("worktree.continueSwitch");
	expect(create).toHaveBeenCalledTimes(1);
	expect((switched.mock.calls[0]?.[0] as { expectedRevision: number }).expectedRevision).toBe(7);
});
async function remount() {
	await act(async () => {
		root.unmount();
		root = createRoot(container);
		root.render(<NarratorWorktreeControls narratorId="n" />);
		await flush();
	});
}
test.each([
	"refresh",
	"nonGit",
])("%s restores same frozen receipt without create or requirement leakage", async (kind) => {
	create.mockRejectedValueOnce(new Error("lost"));
	await openForm();
	await input("worktree.requirement", "private original requirement");
	await submit();
	const original = create.mock.calls[0]?.[1];
	expect([...storage.values()].join("")).not.toContain("private original requirement");
	if (kind === "refresh") await remount();
	else {
		activeContext = {
			...context,
			git: undefined,
			contextKey: "nonGit",
			cwd: "/plain",
			revision: 3,
		};
		await act(async () => root.render(<NarratorWorktreeControls narratorId="n" />));
		expect(container.textContent).toBe("");
		activeContext = { ...context, revision: 4 };
		await act(async () => {
			root.render(<NarratorWorktreeControls narratorId="n" />);
			await flush();
		});
	}
	await openForm();
	expect(container.textContent).toContain("worktree.unknown");
	await submit();
	expect(create).toHaveBeenCalledTimes(1);
	await click("worktree.verify");
	expect(reconcile.mock.calls[0]?.[1]).toEqual(original);
	await click("worktree.continueSwitch");
	expect(create).toHaveBeenCalledTimes(1);
	expect(JSON.parse([...storage.values()][0] ?? "[]")).toEqual([]);
});
test.each([
	"logout",
	"user",
	"narrator",
	"device",
	"repository",
])("pending receipt is isolated on %s", async (kind) => {
	create.mockRejectedValueOnce(new Error("lost"));
	await openForm();
	await input("worktree.name", "old");
	await submit();
	if (kind === "logout") activeUser = undefined;
	if (kind === "user") activeUser = { id: "u2" };
	if (kind === "device") activeContext = { ...context, deviceId: "remote" };
	if (kind === "repository")
		activeContext = {
			...context,
			git: { workspaceKey: "wk", rootPath: "/repo", repositoryKey: "other" },
		};
	await act(async () => {
		root.render(<NarratorWorktreeControls narratorId={kind === "narrator" ? "other" : "n"} />);
		await flush();
	});
	expect(container.textContent).not.toContain("worktree.pendingAttempt");
	expect(container.textContent).not.toContain("worktree.verify");
	expect(reconcile).not.toHaveBeenCalled();
});
test("quota failure blocks dispatch and explicitly disclaims refresh recovery", async () => {
	quotaFailure = true;
	await openForm();
	await input("worktree.name", "fix");
	await submit();
	expect(create).not.toHaveBeenCalled();
	expect(container.textContent).toContain("worktree.receiptStorage");
});
test.each([403, 404])("reconcile HTTP %s keeps remounted unknown receipt", async (status) => {
	create.mockRejectedValueOnce(new FakeApiError("lost", status));
	await openForm();
	await input("worktree.name", "fix");
	await submit();
	await remount();
	await openForm();
	reconcile.mockRejectedValueOnce(new FakeApiError("unavailable", status));
	await click("worktree.verify");
	await submit();
	expect(create).toHaveBeenCalledTimes(1);
	expect(container.textContent).toContain("worktree.unknown");
	expect(JSON.parse([...storage.values()][0] ?? "[]")).toHaveLength(1);
});
test("independent blank form does not restore another proposal; same draft cannot silently redispatch", async () => {
	create.mockRejectedValueOnce(new Error("lost"));
	await openForm();
	await input("worktree.name", "old");
	await submit();
	await remount();
	await click("worktree.switch");
	await click("worktree.independentTask");
	expect((container.querySelector('[aria-label="worktree.name"]') as HTMLInputElement).value).toBe(
		"",
	);
	await input("worktree.name", "old");
	await submit();
	expect(create).toHaveBeenCalledTimes(1);
	await input("worktree.name", "new task");
	await submit();
	expect(create).toHaveBeenCalledTimes(2);
});
test("live pending attempts deliver only their own frozen requirement and retain the other receipt", async () => {
	const delivered = mock((_text: string) => {});
	await act(async () =>
		root.render(<NarratorWorktreeControls narratorId="n" onRequirement={delivered} />),
	);
	create.mockRejectedValueOnce(new Error("lost A"));
	await openForm();
	await input("worktree.requirement", "requirement A");
	await submit();
	await click("worktree.inspectExisting");
	await click("worktree.independentTask");
	prepare.mockResolvedValueOnce({
		branchName: "branch-b",
		worktreeName: "b",
		destinationPath: "/wt/b",
	});
	switched.mockRejectedValueOnce(new FakeApiError("busy", 409));
	await input("worktree.requirement", "requirement B");
	await submit();
	await click("worktree.inspectExisting");
	await click("worktree.pendingAttempt: /wt/named");
	await click("worktree.continueSwitch");
	expect(delivered.mock.calls.map((call) => call[0])).toEqual(["requirement A"]);
	await click("worktree.switch");
	await click("worktree.resumeSwitch: /wt/b");
	await click("worktree.retrySwitch");
	expect(delivered.mock.calls.map((call) => call[0])).toEqual(["requirement A", "requirement B"]);
	expect(create).toHaveBeenCalledTimes(2);
});
test("receipt is persisted before the actual network dispatch", async () => {
	create.mockImplementationOnce(async (_id, request) => {
		expect(JSON.parse([...storage.values()][0] ?? "[]")[0].request).toEqual(request);
		return created();
	});
	await openForm();
	await input("worktree.name", "fix");
	await submit();
	expect(create).toHaveBeenCalledTimes(1);
});
test("capabilities disable create and switch without dropping the strip", async () => {
	activeContext = {
		...context,
		capabilities: { switchDirectory: false, reason: "chapter unsupported" },
	};
	await act(async () => root.render(<NarratorWorktreeControls narratorId="n" />));
	expect(
		container.querySelector('[aria-label="worktree.quickCreate"]')?.hasAttribute("disabled"),
	).toBe(true);
	expect(container.querySelector('[aria-label="worktree.switch"]')?.hasAttribute("disabled")).toBe(
		true,
	);
});
