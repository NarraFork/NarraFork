import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import {
	act,
	type ChangeEvent,
	type ComponentType,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from "react";
import { createRoot, type Root } from "react-dom/client";

const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
// Input changes are emitted by a small native button, avoiding dependence on DOM input polyfills.
const input = ({
	label,
	value,
	error,
	onChange,
	onBlur,
}: {
	label: string;
	value?: string;
	error?: string;
	onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
	onBlur?: () => void;
}) => (
	<div data-input={label} data-value={value} data-error={error ?? ""}>
		<button
			type="button"
			onClick={() =>
				onChange?.({
					currentTarget: { value: edits[label] ?? "edited" },
				} as ChangeEvent<HTMLInputElement>)
			}
		>
			{label}
		</button>
		{onBlur && (
			<button type="button" onClick={onBlur}>
				{`leave:${label}`}
			</button>
		)}
	</div>
);
let edits: Record<string, string> = {};
mock.module("../common/CommandsEditor", () => ({ CommandsEditor: box }));
mock.module("@mantine/core", () => ({
	Alert: box,
	Badge: box,
	Box: box,
	Card: box,
	Code: box,
	Divider: box,
	Group: box,
	Stack: box,
	Text: box,
	Title: box,
	ScrollArea: box,
	SimpleGrid: box,
	Skeleton: box,
	Tooltip: box,
	Loader: box,
	Progress: box,
	ActionIcon: box,
	Checkbox: box,
	Switch: box,
	Select: box,
	SegmentedControl: box,
	// 新建会话弹窗里的提示词优化按钮用的是 TextareaOptimizeControls，它渲染 Mantine 的
	// Menu 与 NumberInput。这里只需形状，不需要行为。
	Menu: Object.assign(box, {
		Target: box,
		Dropdown: box,
		Item: box,
		Label: box,
		Divider: box,
	}),
	NumberInput: box,
	TextInput: input,
	Textarea: input,
	PasswordInput: input,
	Modal: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div>{children}</div> : null,
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
}));
mock.module("@mantine/hooks", () => ({
	useMediaQuery: () => false,
	useDisclosure: () => {
		const [opened, setOpened] = useState(false);
		return [opened, { open: () => setOpened(true), close: () => setOpened(false) }];
	},
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const queryClient = { invalidateQueries: async () => {} };
const instanceSettings = { paths: { defaultProjectDir: "/instance" }, agent: {} };
mock.module("@tanstack/react-query", () => ({
	useMutation: () => mutation,
	useInfiniteQuery: () => ({ data: undefined }),
	useQuery: ({ queryKey, enabled }: { queryKey: readonly unknown[]; enabled?: boolean }) => ({
		// Settings are the only seeded query; anonymous me/preferences observers have no data.
		data: enabled !== false && queryKey[0] === "settings" ? instanceSettings : undefined,
	}),
	useQueryClient: () => queryClient,
}));
mock.module("@mantine/notifications", () => ({
	notifications: { show: () => {} },
}));
mock.module("../../hooks/useGitIdentities", () => ({
	useGitIdentities: () => ({ data: [], isLoading: false, isError: false }),
	useFolderGitIdentity: () => ({ data: undefined }),
	narratorGitIdentityQueryKey: (narratorId: string) => [
		"auth",
		"git-identities",
		"narrator",
		narratorId,
	],
}));
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: unknown) => ({ options }),
	Link: box,
}));
mock.module("../../hooks/usePlatform", () => ({ usePlatform: () => "linux" }));
mock.module("../../hooks/useSetupWizardGuard", () => ({ useSetupWizardGuard: () => () => true }));
mock.module("../../hooks/useModels", () => ({ useAllModels: () => ({ groupedModels: [] }) }));
const validProjectDir = { usablePath: "/instance" as string | null, needsChoice: false };
let projectDirStatus = validProjectDir;
mock.module("../../hooks/useProjectDirStatus", () => ({
	useProjectDirStatus: () => ({ ...projectDirStatus, isLoading: false }),
}));
const create = mock((_data: unknown, _options?: unknown) => {});
const update = mock((_data: unknown, _options?: unknown) => {});
const createProject = mock((_data: unknown, _options?: unknown) => {});
// The real preferences hook unwraps { patch, auth } only after a mutation starts.
const mutation = {
	status: "idle" as const,
	variables: undefined,
	isPending: false,
	mutate: mock((_variables: unknown, _options?: unknown) => {}),
	mutateAsync: mock(async (_variables: unknown, _options?: unknown) => undefined),
	reset: mock(() => {}),
};
mock.module("../../hooks/useNarrator", () => ({ useCreateNarrator: () => ({ mutate: create }) }));
// 弹窗右侧的项目提示词框带「从提示词库插入」，读一个空库即可；库本身有独立测试。
mock.module("../../hooks/usePromptLibrary", () => ({
	usePromptLibrary: () => ({ data: [], isLoading: false }),
	useCreatePrompt: () => mutation,
	useUpdatePrompt: () => mutation,
	useDeletePrompt: () => mutation,
}));
mock.module("../../hooks/useFavoriteDirectories", () => ({
	useFavoriteDirectories: () => ({ data: [] }),
	useCreateFavoriteDirectory: () => mutation,
	useDeleteFavoriteDirectory: () => mutation,
	useReorderFavoriteDirectories: () => mutation,
}));
const projectData = {
	name: "Original project",
	description: "Original description",
	gitPath: "/original",
};
mock.module("../../hooks/useProjects", () => ({
	useProject: () => ({ data: projectData }),
	// Like TanStack Query: a per-call `mutate` callback is dropped once the component unmounts,
	// while `mutateAsync` settles regardless. Both settle through the recorded callbacks.
	useUpdateProject: () => {
		const mounted = useRef(true);
		useEffect(
			() => () => {
				mounted.current = false;
			},
			[],
		);
		return {
			mutate: (variables: unknown, options?: Callbacks) =>
				update(variables, {
					onSuccess: () => {
						if (mounted.current) options?.onSuccess?.();
					},
					onError: (error: Error) => {
						if (mounted.current) options?.onError?.(error);
					},
				}),
			mutateAsync: (variables: unknown) =>
				new Promise((resolve, reject) =>
					update(variables, { onSuccess: resolve, onError: reject }),
				),
		};
	},
	useProjects: () => ({ data: [], isLoading: false }),
	useHiddenProjectExistence: () => ({ data: { hasHidden: false } }),
	useCreateProject: () => ({ ...mutation, mutate: createProject }),
	useCreateProjectStream: () => ({ ...mutation, cloneProgress: "" }),
}));
mock.module("../../lib/api", () => ({
	api: { getSettings: mock(() => {}), listDevices: mock(() => {}) },
	// Device selection reaches the narrator socket manager, which needs the session
	// accessor at import time.
	getToken: () => null,
}));
mock.module("../permissions/PermissionRuleEditor", () => ({
	PermissionRuleEditor: ({
		kind,
		rules,
		onCreate,
		onDelete,
	}: {
		kind: string;
		rules: Array<{ pattern?: string }>;
		onCreate: (rule: Record<string, unknown>) => void;
		onDelete: (index: number) => void;
	}) => (
		<div data-rules={rules.map((rule) => rule.pattern).join(",")}>
			<button
				type="button"
				data-rule-count={rules.length}
				onClick={() => onCreate({ pattern: "/tmp/**" })}
			>
				{`add-rule:${kind}`}
			</button>
			<button type="button" onClick={() => onDelete(0)}>
				delete-first-rule
			</button>
		</div>
	),
}));
mock.module("../settings/TraitLayerEditor", () => ({ TraitLayerEditor: box }));
mock.module("./ProjectAccessPanel", () => ({ ProjectAccessPanel: box }));
mock.module("../common/DirectoryPicker", () => ({
	DirectoryPicker: ({
		label,
		value,
		onChange,
	}: {
		label: string;
		value: string;
		onChange: (value: string) => void;
	}) => input({ label, value, onChange: (event) => onChange(event.currentTarget.value) }),
}));
const { CreateNarratorModal } = await import("../narrator/CreateNarratorModal");
const { ProjectBasicsForm, ProjectRuleList } = await import("./ProjectSettingsForms");
const { Route } = await import("../../routes/projects/index");
const ProjectListPage = Route.options.component as ComponentType;
let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	edits = {};
	projectDirStatus = validProjectDir;
	create.mockClear();
	update.mockClear();
	createProject.mockClear();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
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
async function click(text: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(node) => node.textContent === text,
	);
	expect(button).toBeDefined();
	await act(async () => button?.dispatchEvent(new window.Event("click", { bubbles: true })));
}
test("project creation modal sends explicit membership and allows overriding the default cwd", async () => {
	await act(async () =>
		root.render(
			<CreateNarratorModal
				opened
				onClose={() => {}}
				initialCwd="/project"
				contextProjectId="original-id"
			/>,
		),
	);
	expect(
		container.querySelector('[data-input="workingDirectory"]')?.getAttribute("data-value"),
	).toBe("/project");
	edits.workingDirectory = "/custom";
	await click("workingDirectory");
	await click("createNarrator");
	expect(create.mock.calls[0]?.[0]).toMatchObject({
		contextProjectId: "original-id",
		cwd: "/custom",
	});
});
test("non-project narrator modal retains instance default and omits membership", async () => {
	await act(async () => root.render(<CreateNarratorModal opened onClose={() => {}} />));
	await click("createNarrator");
	expect(create.mock.calls[0]?.[0]).toMatchObject({ cwd: "/instance" });
	expect(create.mock.calls[0]?.[0]).not.toHaveProperty("contextProjectId");
	expect(create.mock.calls[0]?.[0]).not.toHaveProperty("title");
});
test("without a usable default directory the modal requires one before creating", async () => {
	projectDirStatus = { usablePath: null, needsChoice: true };
	await act(async () => root.render(<CreateNarratorModal opened onClose={() => {}} />));
	const createButton = () =>
		Array.from(container.querySelectorAll("button")).find(
			(node) => node.textContent === "createNarrator",
		);
	expect(createButton()?.hasAttribute("disabled")).toBe(true);
	edits.workingDirectory = "/chosen";
	await click("workingDirectory");
	expect(createButton()?.hasAttribute("disabled")).toBe(false);
	await click("createNarrator");
	expect(create.mock.calls[0]?.[0]).toMatchObject({ cwd: "/chosen" });
});
test("a filled session title is trimmed and sent; blank or whitespace is omitted", async () => {
	edits.sessionTitle = "  Sprint review  ";
	await act(async () => root.render(<CreateNarratorModal opened onClose={() => {}} />));
	await click("sessionTitle");
	await click("createNarrator");
	expect(create.mock.calls[0]?.[0]).toMatchObject({ title: "Sprint review" });

	create.mockClear();
	edits.sessionTitle = "   ";
	await act(async () => root.render(<CreateNarratorModal opened onClose={() => {}} />));
	await click("sessionTitle");
	await click("createNarrator");
	expect(create.mock.calls[0]?.[0]).not.toHaveProperty("title");
});
test("closing the dialog clears a typed session title", async () => {
	function Host() {
		const [opened, setOpened] = useState(true);
		return (
			<>
				<button type="button" onClick={() => setOpened(true)}>
					reopen
				</button>
				<CreateNarratorModal opened={opened} onClose={() => setOpened(false)} />
			</>
		);
	}
	edits.sessionTitle = "Keep me";
	await act(async () => root.render(<Host />));
	await click("sessionTitle");
	expect(container.querySelector('[data-input="sessionTitle"]')?.getAttribute("data-value")).toBe(
		"Keep me",
	);
	await click("cancel");
	await click("reopen");
	expect(container.querySelector('[data-input="sessionTitle"]')?.getAttribute("data-value")).toBe(
		"",
	);
	await click("createNarrator");
	expect(create.mock.calls[0]?.[0]).not.toHaveProperty("title");
});
type Callbacks = {
	onSuccess?: () => void;
	onError?: (error: Error) => void;
	onSettled?: () => void;
};
const callbacks = (call: number) => update.mock.calls[call]?.[1] as Callbacks;
const field = (label: string) => container.querySelector(`[data-input="${label}"]`);
const settingsProject = {
	id: "original-id",
	name: "Original project",
	description: "Original description",
	gitPath: "/home/u/repo",
	chapterSettings: { commands: [{ name: "old", prompt: "x" }], futureSetting: { retain: true } },
};
test("name and description save when left, only that field, never a blank name", async () => {
	await act(async () => root.render(<ProjectBasicsForm project={settingsProject} canManage />));
	edits = { projectName: "New name" };
	await click("projectName");
	await click("leave:projectName");
	expect(update.mock.calls[0]?.[0]).toEqual({ id: "original-id", data: { name: "New name" } });
	// Unchanged: nothing is sent.
	await click("leave:projectDescription");
	expect(update).toHaveBeenCalledTimes(1);
	edits = { projectName: "   " };
	await click("projectName");
	await click("leave:projectName");
	expect(update).toHaveBeenCalledTimes(1);
});
test("a failed save keeps the typed value marked unsaved; a saved one shows the stored value again", async () => {
	await act(async () => root.render(<ProjectBasicsForm project={settingsProject} canManage />));
	edits = { projectDescription: "Typed" };
	await click("projectDescription");
	await click("leave:projectDescription");
	await act(async () => callbacks(0).onError?.(new Error("offline")));
	expect(field("projectDescription")?.getAttribute("data-value")).toBe("Typed");
	expect(field("projectDescription")?.getAttribute("data-error")).toBe("settingsPage.unsaved");
	// Leaving again retries; once saved the field follows the stored (server) value.
	await click("leave:projectDescription");
	await act(async () => callbacks(1).onSuccess?.());
	expect(field("projectDescription")?.getAttribute("data-value")).toBe("Original description");
	expect(field("projectDescription")?.getAttribute("data-error")).toBe("");
});
test("the project directory never saves on blur, only on 保存 after a confirmation", async () => {
	await act(async () => root.render(<ProjectBasicsForm project={settingsProject} canManage />));
	edits = { repositoryPath: "/home/u" };
	await click("repositoryPath");
	// No blur save at all: the field has no leave handler.
	expect(
		Array.from(container.querySelectorAll("button")).some(
			(button) => button.textContent === "leave:repositoryPath",
		),
	).toBe(false);
	expect(update).not.toHaveBeenCalled();
	await click("settingsPage.pathSave");
	expect(update).not.toHaveBeenCalled();
	expect(container.textContent).toContain("settingsPage.pathConfirm");
	await click("settingsPage.pathConfirmButton");
	expect(update.mock.calls[0]?.[0]).toEqual({ id: "original-id", data: { gitPath: "/home/u" } });
	// Saved: the field shows the stored, resolved value, and saving again has nothing to send.
	await act(async () => callbacks(0).onSuccess?.());
	expect(field("repositoryPath")?.getAttribute("data-value")).toBe("/home/u/repo");
	const save = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "settingsPage.pathSave",
	);
	expect(save?.disabled).toBe(true);
});
test("the same directory with a trailing slash is not a change; cancel drops the draft", async () => {
	await act(async () => root.render(<ProjectBasicsForm project={settingsProject} canManage />));
	edits = { repositoryPath: "/home/u/repo/" };
	await click("repositoryPath");
	const save = () =>
		Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "settingsPage.pathSave",
		);
	expect(save()?.disabled).toBe(true);
	await click("settingsPage.pathCancel");
	expect(field("repositoryPath")?.getAttribute("data-value")).toBe("/home/u/repo");
	edits = { repositoryPath: "/home/u/other" };
	await click("repositoryPath");
	await click("settingsPage.pathSave");
	await click("settingsPage.pathConfirmButton");
	await act(async () => callbacks(0).onError?.(new Error("not a directory")));
	expect(field("repositoryPath")?.getAttribute("data-value")).toBe("/home/u/other");
	expect(field("repositoryPath")?.getAttribute("data-error")).toBe("settingsPage.unsaved");
});
test("a rule list saves on every change and sends only its own key", async () => {
	const project = {
		id: "original-id",
		name: "p",
		chapterSettings: { whitelistDirs: [], commands: [{ name: "old", prompt: "x" }] },
	};
	await act(async () =>
		root.render(<ProjectRuleList project={project} ruleKey="whitelistDirs" canManage />),
	);
	await click("add-rule:directoryWhitelist");
	const sent = update.mock.calls[0]?.[0] as {
		id: string;
		data: { chapterSettings: Record<string, unknown[]> };
	};
	expect(sent.id).toBe("original-id");
	expect(Object.keys(sent.data)).toEqual(["chapterSettings"]);
	expect(Object.keys(sent.data.chapterSettings)).toEqual(["whitelistDirs"]);
	expect(sent.data.chapterSettings.whitelistDirs).toHaveLength(1);
	expect(create).not.toHaveBeenCalled();
	const editor = () => container.querySelector("[data-rule-count]");
	expect(editor()?.getAttribute("data-rule-count")).toBe("1");
	// A failed save puts the stored list back instead of showing the unsaved rule as saved.
	await act(async () => callbacks(0).onError?.(new Error("offline")));
	expect(editor()?.getAttribute("data-rule-count")).toBe("0");
});
test("name: a late success after more typing keeps the newer edit, saved when left", async () => {
	await act(async () => root.render(<ProjectBasicsForm project={settingsProject} canManage />));
	edits = { projectName: "First" };
	await click("projectName");
	await click("leave:projectName");
	edits = { projectName: "Second" };
	await click("projectName");
	// The first save answers after the second edit, before the field is left again.
	await act(async () => callbacks(0).onSuccess?.());
	expect(field("projectName")?.getAttribute("data-value")).toBe("Second");
	await click("leave:projectName");
	expect(update.mock.calls[1]?.[0]).toEqual({ id: "original-id", data: { name: "Second" } });
	// And a late failure of the first save does not mark the newer edit.
	await act(async () => callbacks(0).onError?.(new Error("late")));
	expect(field("projectName")?.getAttribute("data-error")).toBe("");
});
const twoRules = {
	id: "original-id",
	name: "p",
	chapterSettings: { blacklistDirs: [{ pattern: "/a" }, { pattern: "/b" }] },
};
const shownRules = () => container.querySelector("[data-rules]")?.getAttribute("data-rules");
const sentRules = (call: number) =>
	(
		(update.mock.calls[call]?.[0] as { data: { chapterSettings: Record<string, unknown[]> } }).data
			.chapterSettings.blacklistDirs as Array<{ pattern: string }>
	).map((rule) => rule.pattern);
test("a second deletion while the refetch is still out never brings the first back", async () => {
	await act(async () =>
		root.render(<ProjectRuleList project={twoRules} ruleKey="blacklistDirs" canManage />),
	);
	await click("delete-first-rule");
	expect(sentRules(0)).toEqual(["/b"]);
	// Saved, but the cached project is still the old one (the refetch is held open).
	await act(async () => callbacks(0).onSuccess?.());
	await act(async () =>
		root.render(<ProjectRuleList project={twoRules} ruleKey="blacklistDirs" canManage />),
	);
	expect(shownRules()).toBe("/b");
	await click("delete-first-rule");
	expect(sentRules(1)).toEqual([]);
	// Once the cache holds the saved list, the form follows it again.
	await act(async () => callbacks(1).onSuccess?.());
	await act(async () =>
		root.render(
			<ProjectRuleList
				project={{ ...twoRules, chapterSettings: { blacklistDirs: [] } }}
				ruleKey="blacklistDirs"
				canManage
			/>,
		),
	);
	expect(shownRules()).toBe("");
});
test("rule saves are serialized: an edit made while one is in flight is sent after it", async () => {
	await act(async () =>
		root.render(<ProjectRuleList project={twoRules} ruleKey="blacklistDirs" canManage />),
	);
	await click("delete-first-rule");
	await click("delete-first-rule");
	expect(update).toHaveBeenCalledTimes(1);
	expect(shownRules()).toBe("");
	await act(async () => callbacks(0).onSuccess?.());
	expect(update).toHaveBeenCalledTimes(2);
	expect(sentRules(1)).toEqual([]);
});
test("leaving settings mid-save still sends the queued rule list", async () => {
	await act(async () =>
		root.render(<ProjectRuleList project={twoRules} ruleKey="blacklistDirs" canManage />),
	);
	await click("delete-first-rule");
	await click("delete-first-rule");
	expect(update).toHaveBeenCalledTimes(1);
	await act(async () => root.unmount());
	root = createRoot(container);
	await act(async () => callbacks(0).onSuccess?.());
	expect(update).toHaveBeenCalledTimes(2);
	expect(sentRules(1)).toEqual([]);
});
test("a reader sees the rules but no editor", async () => {
	await act(async () =>
		root.render(
			<ProjectRuleList
				project={{ id: "p", chapterSettings: { commandBlacklist: [{ pattern: "rm" }] } }}
				ruleKey="commandBlacklist"
				canManage={false}
			/>,
		),
	);
	expect(container.textContent).toContain("settingsPage.rulesCount");
	expect(container.textContent).not.toContain("add-rule");
});
test("existing-directory project create sends no deprecated flow selector or git-init fallback", async () => {
	await act(async () => root.render(<ProjectListPage />));
	await click("newProject");
	edits = { projectName: "Directory project", repositoryPath: "/plain-directory" };
	await click("projectName");
	await click("repositoryPath");
	await click("create");
	expect(createProject.mock.calls[0]?.[0]).toEqual({
		name: "Directory project",
		gitPath: "/plain-directory",
		repoMode: "existing",
	});
	expect(container.textContent).not.toContain("flowMode");
	expect(container.textContent).not.toContain("notGitRepoInitAndCreate");
});
