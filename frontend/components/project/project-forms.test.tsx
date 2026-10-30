import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ChangeEvent, type ComponentType, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
// Input changes are emitted by a small native button, avoiding dependence on DOM input polyfills.
const input = ({
	label,
	value,
	onChange,
}: {
	label: string;
	value?: string;
	onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
}) => (
	<div data-input={label} data-value={value}>
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
	</div>
);
let edits: Record<string, string> = {};
mock.module("@mantine/core", () => ({
	Alert: box,
	Badge: box,
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
mock.module("@tanstack/react-query", () => ({
	useMutation: () => mutation,
	useQuery: () => ({ data: { paths: { defaultProjectDir: "/instance" }, agent: {} } }),
	useQueryClient: () => ({ invalidateQueries: () => {} }),
}));
mock.module("@mantine/notifications", () => ({
	notifications: { show: () => {} },
}));
mock.module("../../hooks/useGitIdentities", () => ({
	useGitIdentities: () => ({ data: [], isLoading: false, isError: false }),
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
const mutation = { mutate: mock(() => {}), reset: mock(() => {}), isPending: false };
mock.module("../../hooks/useNarrator", () => ({ useCreateNarrator: () => ({ mutate: create }) }));
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
	useUpdateProject: () => ({ mutate: update }),
	useProjects: () => ({ data: [], isLoading: false }),
	useHiddenProjectExistence: () => ({ data: { hasHidden: false } }),
	useCreateProject: () => ({ ...mutation, mutate: createProject }),
	useCreateProjectStream: () => ({ ...mutation, cloneProgress: "" }),
}));
mock.module("../../lib/api", () => ({
	api: { getSettings: mock(() => {}), listDevices: mock(() => {}) },
}));
mock.module("../permissions/PermissionRuleEditor", () => ({ PermissionRuleEditor: box }));
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
const { ProjectSettingsModal } = await import("./ProjectSettingsModal");
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
test("metadata edits submit only this form's settings, not stale commands, routines or unknown keys", async () => {
	const chapterSettings = {
		whitelistDirs: [],
		blacklistDirs: [],
		commandWhitelist: [],
		commandBlacklist: [],
		traits: { existing: true },
		commands: [{ name: "old-command", prompt: "old prompt" }],
		routines: { toolModes: { example: "resident" } },
		futureSetting: { retain: true },
	};
	await act(async () =>
		root.render(
			<ProjectSettingsModal
				projectId="original-id"
				chapterSettings={chapterSettings}
				opened
				onClose={() => {}}
			/>,
		),
	);
	edits = {
		projectName: "New name",
		projectDescription: "New description",
		repositoryPath: "/new-default",
	};
	await click("projectName");
	await click("projectDescription");
	await click("repositoryPath");
	await click("save");
	expect(update.mock.calls[0]?.[0]).toEqual({
		id: "original-id",
		data: {
			name: "New name",
			description: "New description",
			gitPath: "/new-default",
			chapterSettings: {
				whitelistDirs: [],
				blacklistDirs: [],
				commandWhitelist: [],
				commandBlacklist: [],
			},
		},
	});
	expect(create).not.toHaveBeenCalled();
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
