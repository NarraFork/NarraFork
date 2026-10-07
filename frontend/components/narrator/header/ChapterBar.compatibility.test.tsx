import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import type { HTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Root } from "react-dom/client";
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
let chapter: {
	id: string;
	projectId: string;
	status: string;
	title: string;
	branch: string;
	worktreePath: string;
	containerConfig: { services: Record<string, unknown> } | null;
} = {
	id: "chapter",
	projectId: "project",
	status: "active",
	title: "Existing work",
	branch: "old",
	worktreePath: "/original/chapter-path",
	containerConfig: { services: {} },
};
const wake = mock(async () => ({}));
const dormant = mock(async () => ({}));
mock.module("@frontend/hooks/useChapters", () => ({ useChapter: () => ({ data: chapter }) }));
mock.module("@frontend/hooks/useChapterGitStatus", () => ({
	useChapterGitStatus: () => ({ data: undefined }),
}));
mock.module("@frontend/hooks/useContainers", () => ({ useContainers: () => ({ data: [] }) }));
let gitWorkspace: { data?: GitWorkspace; isPending?: boolean; isError?: boolean } = {};
let gitStatus:
	| { branch: string; totalFiles: number; linesAdded: number; linesRemoved: number }
	| undefined;
mock.module("@frontend/hooks/useGit", () => ({
	useGitWorkspace: () => gitWorkspace,
	useGitStatus: () => ({ data: gitStatus }),
	gitWorkspaceTarget: (_id: string, workspace?: GitWorkspace) =>
		workspace?.state === "ready" ? { narratorId: "n" } : null,
}));
let currentCwd = "/different/current-workspace";
let containerSupported = true;
mock.module("@frontend/hooks/useWorkspaceContext", () => ({
	useWorkspaceContext: () => ({
		data: { contextKey: currentCwd, cwd: currentCwd, deviceId: "local", revision: 1 },
	}),
}));
mock.module("@frontend/hooks/usePlatform", () => ({
	useChapterContainersCapability: () => ({ supported: containerSupported, routes: { list: true } }),
}));
mock.module("@frontend/lib/api", () => ({ api: { dormantChapter: dormant, wakeChapter: wake } }));
mock.module("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: async () => {} }),
	useMutation: (options: { mutationFn: () => unknown }) => ({ mutate: () => options.mutationFn() }),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: Record<string, unknown>) =>
			key === "worktree.legacyContainerSource"
				? `original:${values?.title}:${values?.chapterId}:${values?.path}`
				: key,
	}),
}));
mock.module("../dock/NarratorDockContext", () => ({ useNarratorDockContext: () => null }));
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
mock.module("../../project/NarratorCompatibilityEntry", () => ({
	NarratorCompatibilityModal: ({
		projectId,
		opened,
	}: {
		projectId: string;
		opened: boolean;
		onClose: () => void;
	}) => (opened ? <div data-compatibility-modal>compatibility:{projectId}</div> : null),
}));
mock.module("@frontend/components/chapter/ChapterForkModal", () => ({
	ChapterForkModal: () => <div data-legacy-fork />,
}));
mock.module("@frontend/components/chapter/ChapterMergeModal", () => ({
	ChapterMergeModal: () => <div data-legacy-merge />,
}));
const renderedContainerTargets: string[] = [];
mock.module("@frontend/components/container/ContainerPanel", () => ({
	ContainerPanel: ({
		chapterId,
		onOpenConfig,
	}: {
		chapterId: string;
		onOpenConfig: () => void;
	}) => {
		renderedContainerTargets.push(chapterId);
		return (
			<div data-legacy-container data-target={chapterId}>
				<button type="button" onClick={onOpenConfig}>
					panel-config
				</button>
			</div>
		);
	},
}));
const renderedConfigTargets: Array<{ chapterId: string; targetDescription?: string }> = [];
mock.module("@frontend/components/container/ContainerConfigModal", () => ({
	ContainerConfigModal: (props: { chapterId: string; targetDescription?: string }) => {
		renderedConfigTargets.push(props);
		return (
			<div data-legacy-config data-target={props.chapterId}>
				{props.targetDescription}
			</div>
		);
	},
}));
type WrapperProps = { children?: ReactNode };
const Wrapper = ({ children, onClick, onKeyDown, role, style }: HTMLAttributes<HTMLDivElement>) => (
	// biome-ignore lint/a11y/noStaticElementInteractions: mock forwards Mantine Group event handlers and dynamic role
	<div role={role} onClick={onClick} onKeyDown={onKeyDown} style={style}>
		{children}
	</div>
);
const Button = ({
	children,
	onClick,
	disabled,
	"aria-label": label,
}: WrapperProps & { onClick?: () => void; disabled?: boolean; "aria-label"?: string }) => (
	<button type="button" onClick={onClick} disabled={disabled} aria-label={label}>
		{children}
	</button>
);
mock.module("@mantine/core", () => ({
	Group: Wrapper,
	Badge: Wrapper,
	Text: Wrapper,
	Stack: Wrapper,
	Tooltip: Wrapper,
	ActionIcon: (
		props: WrapperProps & { onClick?: () => void; disabled?: boolean; "aria-label"?: string },
	) => (
		<div data-main-action-icon>
			<Button {...props} />
		</div>
	),
	Drawer: ({ opened, children }: WrapperProps & { opened: boolean }) =>
		opened ? <div data-resource-drawer>{children}</div> : null,
	Menu: Object.assign(Wrapper, {
		Target: Wrapper,
		Dropdown: ({ children }: WrapperProps) => <div data-compatibility-menu>{children}</div>,
		Label: Wrapper,
		Divider: () => <hr />,
		Item: Button,
	}),
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChapterBar, NarratorGitBar } = await import("./ChapterBar");
let root: Root;
let container: HTMLElement;
async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function click(label: string) {
	const target = [...container.querySelectorAll("button")].find(
		(node) => node.getAttribute("aria-label") === label || node.textContent === label,
	);
	expect(target).toBeDefined();
	await act(async () => {
		target?.click();
		await flush();
	});
}
beforeEach(async () => {
	gitWorkspace = {};
	gitStatus = undefined;
	chapter = { ...chapter, status: "active", containerConfig: { services: {} } };
	currentCwd = "/different/current-workspace";
	containerSupported = true;
	renderedContainerTargets.length = 0;
	renderedConfigTargets.length = 0;
	dormant.mockClear();
	wake.mockClear();
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root.render(<ChapterBar chapterId="chapter" narratorId="n" />);
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
test("non-Git and unresolved standalone workspaces never reserve a strip", async () => {
	gitWorkspace = { isPending: true };
	await act(async () => {
		root.render(<NarratorGitBar narratorId="n" onOpenGitPanel={() => {}} />);
		await flush();
	});
	expect(container.textContent).toBe("");
	gitWorkspace = { data: { state: "not_git" } as GitWorkspace };
	await act(async () => {
		root.render(<NarratorGitBar narratorId="n" onOpenGitPanel={() => {}} />);
		await flush();
	});
	expect(container.textContent).toBe("");
});
for (const variant of ["chapter", "standalone"] as const) {
	test(`${variant} shows summary branch before statistics and keeps a fixed strip height`, async () => {
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
		const render = () =>
			root.render(
				variant === "chapter" ? (
					<ChapterBar chapterId="chapter" narratorId="n" />
				) : (
					<NarratorGitBar narratorId="n" onOpenGitPanel={() => {}} />
				),
			);
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
	});
}
for (const variant of ["chapter", "standalone"] as const) {
	test(`${variant} Git row ignores worktree portal clicks and activation keys`, async () => {
		const openGit = mock(() => {});
		await act(async () => {
			root.render(
				variant === "chapter" ? (
					<ChapterBar chapterId="chapter" narratorId="n" onOpenGitPanel={openGit} />
				) : (
					<NarratorGitBar narratorId="n" onOpenGitPanel={openGit} />
				),
			);
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
}

test("old fork, merge, containers and project compatibility remain reachable beside quick worktree", async () => {
	expect(container.textContent).toContain("quick-worktree");
	// The menu row is a plain item; the modal marker only appears after activation.
	expect(container.querySelector("[data-compatibility-modal]")).toBeNull();
	await click("compatibility.title");
	expect(container.querySelector("[data-compatibility-modal]")?.textContent).toContain(
		"compatibility:project",
	);
	await click("fork");
	expect(container.querySelector("[data-legacy-fork]")).not.toBeNull();
	await click("merge");
	expect(container.querySelector("[data-legacy-merge]")).not.toBeNull();
	await click("chapterBar.containers");
	expect(container.querySelector("[data-legacy-container]")).not.toBeNull();
});
test("primary Git row has no direct container action; compatibility drawer and configuration retain the original target", async () => {
	expect(
		[...container.querySelectorAll("[data-main-action-icon] button")].some(
			(button) => button.getAttribute("aria-label") === "chapterBar.containers",
		),
	).toBe(false);
	expect(container.querySelector("[data-resource-drawer]")).toBeNull();
	expect(container.querySelector("[data-compatibility-menu]")?.textContent).toContain(
		"original:Existing work:chapter:/original/chapter-path",
	);
	await click("chapterBar.containers");
	const drawer = container.querySelector("[data-resource-drawer]");
	expect(drawer?.textContent).toContain("/original/chapter-path");
	expect(drawer?.textContent).toContain("worktree.legacyContainerWarning");
	expect(container.querySelector("[data-legacy-container]")?.getAttribute("data-target")).toBe(
		"chapter",
	);
	currentCwd = "/new/current-workspace";
	await act(async () => {
		root.render(<ChapterBar chapterId="chapter" narratorId="n" />);
		await flush();
	});
	await click("panel-config");
	expect(renderedContainerTargets.every((id) => id === "chapter")).toBe(true);
	expect(renderedConfigTargets.at(-1)?.chapterId).toBe("chapter");
	expect(renderedConfigTargets.at(-1)?.targetDescription).toContain("/original/chapter-path");
	expect(renderedConfigTargets.at(-1)?.targetDescription).not.toContain("/new/current-workspace");
});
test("an unconfigured chapter uses the same compatibility configuration entry and original path", async () => {
	chapter = { ...chapter, containerConfig: null };
	await act(async () => {
		root.render(<ChapterBar chapterId="chapter" narratorId="n" />);
		await flush();
	});
	await click("chapterBar.containers");
	expect(container.querySelector("[data-resource-drawer]")).toBeNull();
	expect(renderedConfigTargets.at(-1)).toMatchObject({ chapterId: "chapter" });
	expect(renderedConfigTargets.at(-1)?.targetDescription).toContain("/original/chapter-path");
});
test("unsupported container capability still blocks both retained menu actions", async () => {
	containerSupported = false;
	await act(async () => {
		root.render(<ChapterBar chapterId="chapter" narratorId="n" />);
		await flush();
	});
	await click("chapterBar.containers");
	await click("worktree.legacyContainerConfigure");
	expect(container.querySelector("[data-resource-drawer]")).toBeNull();
	expect(renderedConfigTargets).toHaveLength(0);
});
test("legacy dormant and wake handlers still operate, without role or graph entry", async () => {
	expect(container.textContent).not.toContain("chapterBar.setRole");
	expect(container.textContent).not.toContain("chapterBar.openInGraph");
	await click("dormant");
	expect(dormant).toHaveBeenCalledTimes(1);
	chapter = { ...chapter, status: "dormant" };
	await act(async () => {
		root.render(<ChapterBar chapterId="chapter" narratorId="n" />);
		await flush();
	});
	await click("wake");
	expect(wake).toHaveBeenCalledTimes(1);
});
