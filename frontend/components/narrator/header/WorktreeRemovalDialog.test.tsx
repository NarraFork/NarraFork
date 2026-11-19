import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { WorktreeRemovalPlan, WorktreeRemovalResult } from "@shared/narrator-worktrees";
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

const blockedPlan = (): WorktreeRemovalPlan => ({
	status: "blocked",
	expectedRevision: 3,
	worktree: {
		path: "/repo/.worktrees/feature",
		branch: "refs/heads/feature",
		head: null,
		detached: false,
		locked: false,
		prunable: true,
		mode: "prune",
		pruneSiblings: 0,
		present: false,
		registered: true,
		registrationId: "registration",
		state: "ready",
		dirty: false,
		dirtyFileCount: 0,
		dirtyExact: true,
		unreachableCommits: 0,
	},
	dependents: [
		{ id: "other", title: "Other task", status: "idle", kind: "primary", running: false },
		{ id: "sub", title: "Sub", status: "archived", kind: "subagent", running: false },
	],
	inventory: {
		backgroundTasks: 0,
		browserSessions: 0,
		terminals: 0,
		containers: 0,
		volumeSnapshots: 0,
		treeSnapshots: 0,
	},
	blockers: [
		{
			code: "WORKTREE_REMOVAL_DEPENDENT_NOT_ARCHIVED",
			params: { count: 1 },
			dependents: [
				{ id: "other", title: "Other task", status: "idle", kind: "primary", running: false },
			],
		},
	],
	confirmations: [],
	relocateTo: "/repo",
});
const readyPlan = (): WorktreeRemovalPlan => ({
	...blockedPlan(),
	status: "ready",
	blockers: [],
	dependents: [
		{ id: "other", title: "Other task", status: "archived", kind: "primary", running: false },
	],
	confirmations: ["force"],
});
const removed = (): WorktreeRemovalResult => ({
	outcome: "removed",
	worktree: null,
	effects: {
		relocated: 1,
		archivedSubagents: 0,
		cancelledTasks: 0,
		closedBrowsers: 0,
		closedTerminals: 0,
		prunedRegistrations: 1,
		removedTreeSnapshots: 0,
	},
	relocatedTo: "/repo",
});

const plans = mock(
	async (_id: string, _input: unknown): Promise<WorktreeRemovalPlan> => blockedPlan(),
);
const remove = mock(
	async (_id: string, _input: unknown): Promise<WorktreeRemovalResult> => removed(),
);
const archive = mock(async (_id: string) => ({}));
class FakeApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly data?: Record<string, unknown>,
	) {
		super(message);
	}
}
mock.module("@frontend/lib/api", () => ({
	api: {
		planNarratorWorktreeRemoval: plans,
		removeNarratorWorktree: remove,
		archiveNarrator: archive,
	},
	ApiError: FakeApiError,
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@tabler/icons-react", () => ({
	IconTrash: () => null,
	IconAlertTriangle: () => null,
}));
type Children = { children?: ReactNode };
const Wrapper = ({ children }: Children) => <div>{children}</div>;
mock.module("@mantine/core", () => ({
	Group: Wrapper,
	Stack: Wrapper,
	Text: ({ children }: Children) => <span>{children}</span>,
	Alert: Wrapper,
	Badge: ({ children }: Children) => <span>{children}</span>,
	Divider: () => <hr />,
	Loader: () => <span>loader</span>,
	Modal: ({ opened, children }: Children & { opened: boolean }) =>
		opened ? <div data-modal>{children}</div> : null,
	Button: ({
		children,
		onClick,
		disabled,
	}: Children & { onClick?: () => void; disabled?: boolean }) => (
		<button type="button" disabled={disabled} onClick={onClick}>
			{children}
		</button>
	),
	Checkbox: ({
		label,
		checked,
		onChange,
		disabled,
	}: {
		label: string;
		checked: boolean;
		onChange: (event: { currentTarget: { checked: boolean } }) => void;
		disabled?: boolean;
	}) => (
		<label>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onChange({ currentTarget: { checked: event.currentTarget.checked } })}
			/>
			{label}
		</label>
	),
}));

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorktreeRemovalDialog } = await import("./WorktreeRemovalDialog");
let root: Root;
let container: HTMLElement;
let removedResults: WorktreeRemovalResult[];
async function flush() {
	for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
function buttons() {
	return [...container.querySelectorAll("button")];
}
async function click(text: string) {
	const button = buttons().find((node) => node.textContent === text);
	expect(button).toBeDefined();
	await act(async () => {
		button?.click();
		await flush();
	});
}
async function render(opened = true) {
	await act(async () => {
		root.render(
			<WorktreeRemovalDialog
				opened={opened}
				narratorId="narrator"
				worktreePath="/repo/.worktrees/feature"
				workspaceKey="workspace"
				onClose={() => {}}
				onRemoved={(result) => removedResults.push(result)}
			/>,
		);
		await flush();
	});
}
beforeEach(async () => {
	plans.mockClear();
	remove.mockClear();
	archive.mockClear();
	plans.mockImplementation(async () => blockedPlan());
	remove.mockImplementation(async () => removed());
	removedResults = [];
	container = window.document.createElement("div");
	window.document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
	}
});

test("shows the prunable state, dependents and the blocking reason, and refuses to submit", async () => {
	await render();
	expect(plans).toHaveBeenCalledTimes(1);
	const text = container.textContent ?? "";
	expect(text).toContain("worktree.removePruneOnly");
	expect(text).toContain("Other task");
	expect(text).toContain("worktree.removeDependentSubagent");
	// With a key-echoing `t`, an untranslated blocker falls back to its stable code.
	expect(text).toContain("WORKTREE_REMOVAL_DEPENDENT_NOT_ARCHIVED");
	// The archive action exists exactly once: only the unarchived root conversation needs it.
	expect(buttons().filter((node) => node.textContent === "worktree.removeArchive")).toHaveLength(1);
	const confirm = buttons().find((node) => node.textContent === "worktree.removeConfirm");
	expect(confirm?.disabled).toBe(true);
});

test("archiving the blocker re-reads the plan, then a confirmation unlocks the removal", async () => {
	// The dialog opens on the blocked plan; the archive-triggered re-read returns a ready one.
	plans.mockImplementation(async () => readyPlan());
	plans.mockImplementationOnce(async () => blockedPlan());
	await render();
	await click("worktree.removeArchive");
	expect(archive).toHaveBeenCalledWith("other");
	expect(plans).toHaveBeenCalledTimes(2);
	const confirm = () => buttons().find((node) => node.textContent === "worktree.removeConfirm");
	expect(confirm()?.disabled).toBe(true);
	const checkbox = container.querySelector("input[type=checkbox]") as HTMLInputElement;
	await act(async () => {
		// React derives a checkbox's change from the click event's current `checked`.
		checkbox.checked = true;
		checkbox.dispatchEvent(new window.Event("click", { bubbles: true }));
		await flush();
	});
	expect(confirm()?.disabled).toBe(false);
	await click("worktree.removeConfirm");
	expect(remove).toHaveBeenCalledTimes(1);
	expect(remove.mock.calls[0]?.[1]).toMatchObject({
		expectedRevision: 3,
		workspaceKey: "workspace",
		path: "/repo/.worktrees/feature",
		force: true,
		confirmedLoss: { head: null, dirtyFileCount: 0, unreachableCommits: 0 },
	});
	expect(removedResults).toHaveLength(1);
	expect(removedResults[0]?.outcome).toBe("removed");
});

test("a closed dialog loads nothing", async () => {
	await render(false);
	expect(plans).not.toHaveBeenCalled();
	expect(container.querySelector("[data-modal]")).toBeNull();
});

test("a present checkout says ignored files go with it, and shows loss a branch does not keep", async () => {
	plans.mockImplementation(async () => {
		const plan = readyPlan();
		plan.worktree = {
			...plan.worktree,
			mode: "remove",
			present: true,
			dirty: true,
			dirtyFileCount: 3,
			dirtyExact: false,
			unreachableCommits: 2,
		};
		return plan;
	});
	await render();
	const text = container.textContent ?? "";
	expect(text).toContain("worktree.removeIgnoredNote");
	expect(text).toContain("worktree.removeDirtyAtLeast");
	expect(text).toContain("worktree.removeUnreachable");
});

test("rows mode never offers a force confirmation, whatever an older server sends", async () => {
	plans.mockImplementation(async () => {
		const plan = readyPlan();
		plan.worktree = { ...plan.worktree, mode: "rows", present: true };
		plan.confirmations = ["force"];
		return plan;
	});
	await render();
	expect(container.querySelector("input[type=checkbox]")).toBeNull();
	const confirm = buttons().find((node) => node.textContent === "worktree.removeConfirm");
	expect(confirm?.disabled).toBe(false);
	expect(container.textContent ?? "").not.toContain("worktree.removeIgnoredNote");
});
