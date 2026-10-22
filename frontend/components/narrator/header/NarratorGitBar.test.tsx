import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { HTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Root } from "react-dom/client";
import type { GitLineStats } from "../../../../shared/git-line-stats";
import type { GitWorkspace } from "../../../../shared/git-workspace";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const { window } = parseHTML("<!doctype html><html><body></body></html>");
Object.defineProperty(window, "getSelection", { configurable: true, value: () => null });
Object.assign(globalThis, {
	window,
	document: window.document,
	navigator: window.navigator,
	IS_REACT_ACT_ENVIRONMENT: true,
});
let gitWorkspace: { data?: GitWorkspace; isPending?: boolean; isError?: boolean } = {};
let gitStatus:
	| {
			branch: string;
			totalFiles: number;
			totalFilesExact?: boolean;
			truncated?: boolean;
			linesAdded?: number;
			linesRemoved?: number;
	  }
	| undefined;
let lineStats: { data?: GitLineStats; isFetching: boolean; error: Error | null } = {
	isFetching: true,
	error: null,
};
mock.module("@frontend/hooks/useGit", () => ({
	useGitWorkspace: () => gitWorkspace,
	useGitStatus: () => ({ data: gitStatus }),
	useGitLineStats: () => lineStats,
	gitWorkspaceTarget: (_id: string, workspace?: GitWorkspace) =>
		workspace?.state === "ready" && workspace.capabilities?.read ? { narratorId: "n" } : null,
}));
const currentCwd = "/different/current-workspace";
mock.module("@frontend/hooks/useWorkspaceContext", () => ({
	useWorkspaceContext: () => ({
		data: { contextKey: currentCwd, cwd: currentCwd, deviceId: "local", revision: 1 },
	}),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			key === "workspace.atLeastFiles" ? `at least ${values?.count}` : key,
	}),
}));
mock.module("./NarratorWorktreeControls", () => ({
	NarratorWorktreeControls: () => (
		<>
			<span>quick-worktree</span>
			{createPortal(
				<button type="button" data-worktree-dialog>
					dialog
				</button>,
				document.body,
			)}
		</>
	),
}));
type WrapperProps = { children?: ReactNode };
const Wrapper = ({
	children,
	onClick,
	onKeyDown,
	role,
	style,
	"aria-label": label,
}: HTMLAttributes<HTMLDivElement>) => (
	// biome-ignore lint/a11y/noStaticElementInteractions: mock forwards Mantine Group event handlers and dynamic role
	// biome-ignore lint/a11y/useAriaPropsSupportedByRole: mock forwards names with the dynamically selected role
	<div
		role={role ?? (label ? "group" : undefined)}
		onClick={onClick}
		onKeyDown={onKeyDown}
		style={style}
		aria-label={label}
	>
		{children}
	</div>
);
mock.module("@mantine/core", () => ({
	Group: Wrapper,
	Badge: Wrapper,
	Text: Wrapper,
	Stack: Wrapper,
	Skeleton: Wrapper,
	Tooltip: ({ children }: WrapperProps) => <div>{children}</div>,
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NarratorGitBar } = await import("./NarratorGitBar");
let root: Root;
let container: HTMLElement;
async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
	gitWorkspace = {};
	gitStatus = undefined;
	lineStats = { isFetching: true, error: null };
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const node of document.querySelectorAll("[data-worktree-dialog]")) node.remove();
});
afterAll(() => {
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});
test("cold and cached non-Git use the same fixed cwd slot without Git activation", async () => {
	gitWorkspace = { isPending: true };
	await act(async () => {
		root.render(<NarratorGitBar narratorId="n" onOpenGitPanel={() => {}} />);
		await flush();
	});
	const slot = container.firstElementChild as HTMLElement;
	expect(slot.style.height).toBe("30px");
	expect(container.querySelector('[role="button"]')).toBeNull();
	gitWorkspace = { data: { state: "not_git" } as GitWorkspace };
	await act(async () => {
		root.render(<NarratorGitBar narratorId="n" onOpenGitPanel={() => {}} />);
		await flush();
	});
	expect(container.firstElementChild).toBe(slot);
	expect(slot.style.height).toBe("30px");
	expect(container.textContent).toContain(currentCwd);
	await act(async () => {
		root.render(<NarratorGitBar key="cached-remount" narratorId="n" onOpenGitPanel={() => {}} />);
		await flush();
	});
	expect((container.firstElementChild as HTMLElement).style.height).toBe("30px");
	expect(container.textContent).toContain(currentCwd);
	expect(container.querySelector('[role="button"]')).toBeNull();
});

test("cached non-Git becomes an activatable read-only Git row in place after git init", async () => {
	gitWorkspace = {
		data: { state: "not_git", capabilities: { read: false, write: false } } as GitWorkspace,
	};
	const openGit = mock(() => {});
	const render = () => root.render(<NarratorGitBar narratorId="n" onOpenGitPanel={openGit} />);
	await act(async () => {
		render();
		await flush();
	});
	const slot = container.firstElementChild as HTMLElement;
	expect(slot.style.height).toBe("30px");
	expect(container.querySelector('[role="button"]')).toBeNull();
	await act(async () => slot.click());
	expect(openGit).not.toHaveBeenCalled();
	gitWorkspace = {
		data: {
			state: "ready",
			branch: "initialized",
			capabilities: { read: true, write: false },
		} as GitWorkspace,
	};
	await act(async () => {
		render();
		await flush();
	});
	expect(container.firstElementChild).toBe(slot);
	expect(slot.style.height).toBe("30px");
	expect(container.textContent).toContain("initialized");
	expect(container.textContent).toContain("workspace.readOnly");
	await act(async () => container.querySelector<HTMLElement>('[role="button"]')?.click());
	expect(openGit).toHaveBeenCalledTimes(1);
});

test("shows summary branch before statistics and keeps a fixed strip height", async () => {
	gitWorkspace = {
		isPending: true,
		data: {
			state: "ready",
			branch: "summary-branch",
			capabilities: { read: true, write: true },
			deviceId: "local",
			cwd: "/repo",
			rootPath: "/repo",
			workspaceKey: "local:/repo",
			repositoryKey: "local:/repo",
		},
	};
	const render = () => root.render(<NarratorGitBar narratorId="n" onOpenGitPanel={() => {}} />);
	await act(async () => {
		render();
		await flush();
	});
	expect(container.textContent).toContain("summary-branch");
	const strip = container.firstElementChild as HTMLElement;
	expect(strip.style.height).toBe("30px");
	gitStatus = {
		branch: "authoritative-branch",
		totalFiles: 12,
		linesAdded: 100,
		linesRemoved: 2,
	};
	await act(async () => {
		render();
		await flush();
	});
	expect(container.textContent).toContain("authoritative-branch");
	expect((container.firstElementChild as HTMLElement).style.height).toBe("30px");
	gitStatus = { branch: "lightweight", totalFiles: 12, totalFilesExact: false };
	await act(async () => {
		render();
		await flush();
	});
	expect(container.textContent).toContain("at least 12");
	expect(container.textContent).not.toContain("+100");
	expect(container.textContent).not.toContain("-2");
	expect(container.textContent).not.toMatch(/[+-]0|NaN/);
	gitStatus = { ...gitStatus, totalFilesExact: true, truncated: true };
	await act(async () => {
		render();
		await flush();
	});
	expect(container.textContent).not.toContain("at least");
});

test("refreshes totals silently and labels partial and unsupported stats", async () => {
	gitWorkspace = {
		data: {
			state: "ready",
			branch: "main",
			capabilities: { read: true, write: true },
		} as GitWorkspace,
	};
	gitStatus = { branch: "main", totalFiles: 3, linesAdded: 999, linesRemoved: 999 };
	const render = async () => {
		await act(async () => {
			root.render(<NarratorGitBar narratorId="n" onOpenGitPanel={() => {}} />);
			await flush();
		});
	};
	await render();
	expect(container.textContent).toContain("main");
	expect(container.textContent).not.toContain("999");
	expect(container.querySelector('[aria-label="lineStats.loading"]')).not.toBeNull();
	lineStats = {
		data: { files: [], linesAdded: 12, linesRemoved: 4, complete: false },
		isFetching: false,
		error: null,
	};
	await render();
	expect(container.textContent).toContain("+12");
	expect(container.textContent).toContain("-4");
	expect(container.querySelector('[aria-label="lineStats.partial"]')).not.toBeNull();
	const measuredText = container.textContent;
	lineStats = { ...lineStats, isFetching: true };
	await render();
	expect(container.textContent).toBe(measuredText);
	expect(container.querySelector('[role="status"]')).toBeNull();
	expect(container.textContent).not.toContain("…");
	lineStats = {
		data: { files: [], linesAdded: 18, linesRemoved: 6, complete: true },
		isFetching: false,
		error: null,
	};
	await render();
	expect(container.textContent).toContain("+18");
	expect(container.textContent).toContain("-6");
	expect(container.querySelector('[role="status"]')).toBeNull();
	lineStats = {
		...lineStats,
		isFetching: false,
		error: Object.assign(new Error("unsupported"), {
			data: { code: "GIT_LINE_STATS_UNSUPPORTED" },
		}),
	};
	await render();
	expect(container.textContent).toContain("lineStats.unsupported");
	expect(container.textContent).not.toContain("+18");
	expect(container.textContent).toContain("main");
});

test("Git row ignores worktree portal clicks and activation keys", async () => {
	gitWorkspace = {
		data: { state: "ready", capabilities: { read: true, write: true } } as GitWorkspace,
	};
	const openGit = mock(() => {});
	await act(async () => {
		root.render(<NarratorGitBar narratorId="n" onOpenGitPanel={openGit} />);
		await flush();
	});
	expect(container.textContent).not.toContain("current-workspace");
	expect(container.textContent).not.toContain("local:");
	const dialog = document.querySelector<HTMLElement>("[data-worktree-dialog]");
	if (!dialog) throw new Error("Missing worktree dialog portal");
	await act(async () => {
		dialog.click();
		for (const key of ["Enter", " "]) {
			const event = new window.Event("keydown", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "key", { value: key });
			dialog.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
		}
	});
	expect(openGit).not.toHaveBeenCalled();
	await act(async () => {
		container.querySelector<HTMLElement>('[role="button"]')?.click();
	});
	expect(openGit).toHaveBeenCalledTimes(1);
});
