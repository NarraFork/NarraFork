import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
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
const directories = new Set<string>();
let parent = "/repo";
let entries: { name: string; path: string; isDirectory?: boolean }[] = [];
const mkdir = mock(async (path: string, name: string) => {
	const result = `${path}/${name}`;
	directories.add(result);
	return { path: result };
});
const browse = mock(async (path?: string, _opts?: unknown) => ({
	path: path ?? parent,
	parent: "/",
	entries,
}));
mock.module("./PathInput", () => ({ PathInput: () => null }));
mock.module("../../lib/api", () => ({ api: { fsBrowse: browse, fsMkdir: mkdir } }));
mock.module("../../hooks/usePlatform", () => ({
	useFileSystemCapability: () => ({
		browse: { supported: true },
		mkdir: { supported: true },
		shortcuts: { supported: false },
	}),
}));
mock.module("../../hooks/useFavoriteDirectories", () => ({
	useFavoriteDirectories: () => ({ data: [] }),
	useCreateFavoriteDirectory: () => ({ mutate: () => {} }),
	useDeleteFavoriteDirectory: () => ({ mutate: () => {} }),
	useReorderFavoriteDirectories: () => ({ mutate: () => {} }),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
type Children = { children?: ReactNode };
const Wrapper = ({ children }: Children) => <div>{children}</div>;
mock.module("@dnd-kit/core", () => ({
	closestCenter: () => {},
	DndContext: Wrapper,
	DragOverlay: Wrapper,
	PointerSensor: class {},
	useSensor: () => ({}),
	useSensors: () => [],
}));
mock.module("@dnd-kit/sortable", () => ({
	SortableContext: Wrapper,
	useSortable: () => ({}),
	verticalListSortingStrategy: {},
}));
mock.module("@mantine/core", () => {
	const Button = ({
		children,
		onClick,
		onDoubleClick,
		disabled,
		title,
	}: Children & {
		onClick?: () => void;
		onDoubleClick?: () => void;
		disabled?: boolean;
		title?: string;
	}) => (
		<button
			type="button"
			onClick={onClick}
			onDoubleClick={onDoubleClick}
			disabled={disabled}
			title={title}
		>
			{children}
		</button>
	);
	return {
		ActionIcon: Button,
		Button,
		UnstyledButton: Button,
		Divider: Wrapper,
		Group: Wrapper,
		Loader: Wrapper,
		Modal: Wrapper,
		NavLink: Wrapper,
		ScrollArea: Wrapper,
		Stack: Wrapper,
		Text: Wrapper,
		Tooltip: ({ children, label }: Children & { label: string }) => (
			<div data-tooltip={label}>{children}</div>
		),
		TextInput: ({
			value,
			onChange,
			error,
			placeholder,
			"aria-label": label,
		}: {
			value: string;
			onChange: (event: unknown) => void;
			error?: string;
			placeholder?: string;
			"aria-label"?: string;
		}) => (
			<label>
				<input aria-label={label ?? placeholder} value={value} onInput={onChange} />
				{error}
			</label>
		),
	};
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { DirectoryBrowser } = await import("./DirectoryPicker");
let root: Root;
let container: HTMLElement;
let client: InstanceType<typeof QueryClient>;
const selected = mock((_path: string) => {});
async function flush() {
	for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
async function render(mode: "existing" | "newTarget" = "newTarget") {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<DirectoryBrowser
					mode={mode}
					initialPath={parent}
					newTargetError="target unavailable; never overwrite"
					onSelect={selected}
					onCancel={() => {}}
				/>
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		await flush();
	});
}
async function input(name: string) {
	await act(async () => {
		const field = container.querySelector(
			'input[aria-label="newFolderPlaceholder"]',
		) as HTMLInputElement;
		field.value = name;
		field.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
}
async function select() {
	await act(async () => {
		[...container.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "selectThisDirectory")
			?.click();
		await flush();
	});
}
beforeEach(() => {
	parent = "/repo";
	entries = [];
	directories.clear();
	selected.mockClear();
	mkdir.mockClear();
	browse.mockClear();
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
});
afterAll(() => {
	for (const [key, value] of originals) {
		if (value) Object.defineProperty(globalThis, key, value);
		else Reflect.deleteProperty(globalThis, key);
	}
});
test("new target picks parent + leaf without mkdir and can be passed to a rejecting-existing service fixture", async () => {
	await render();
	await input("new-worktree");
	await select();
	expect(selected.mock.calls[0]?.[0]).toBe("/repo/new-worktree");
	expect(mkdir).not.toHaveBeenCalled();
	const serviceCreate = (path: string) => {
		if (directories.has(path)) throw new Error("exists");
		directories.add(path);
		return path;
	};
	const target = selected.mock.calls[0]?.[0];
	if (!target) throw new Error("Target not selected");
	expect(serviceCreate(target)).toBe("/repo/new-worktree");
	expect(() => serviceCreate(target)).toThrow("exists");
});
test("picked uncreated target succeeds through the real worktree service fixture (no git state mutation)", async () => {
	const { mkdtemp, mkdir: mkdirFixture, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { LocalBackend } = await import("../../../server/lib/agent/execution/local-backend");
	const { FileWorktreeJournal } = await import(
		"../../../server/services/narrator-worktree-journal"
	);
	const { NarratorWorktreeService } = await import(
		"../../../server/services/narrator-worktree-service"
	);
	const temporary = await mkdtemp(join(tmpdir(), "directory-picker-service-"));
	try {
		parent = temporary;
		await mkdirFixture(join(temporary, ".git"));
		await render();
		await input("new-target");
		await select();
		const destination = selected.mock.calls[0]?.[0];
		if (!destination) throw new Error("Target not selected");
		const target = {
			workspace: {
				deviceId: "local",
				cwd: temporary,
				rootPath: temporary,
				workspaceKey: "wk",
				repositoryKey: "rk",
				state: "ready" as const,
				capabilities: { read: true, write: true },
			},
			backend: new LocalBackend(),
			repositoryPath: join(temporary, ".git"),
		};
		let registered = false;
		const head = "a".repeat(40);
		const service = new NarratorWorktreeService<string>({
			authorize: async () => target,
			withRevision: async (_id, _revision, action) => action(),
			withRepositoryLock: async (_key, action) => action(),
			journal: new FileWorktreeJournal(join(temporary, "receipts")),
			runGit: async (workspace, args) => {
				let stdout = "";
				let exitCode = 0;
				if (args[0] === "worktree" && args[1] === "add") {
					await mkdirFixture(destination);
					registered = true;
				} else if (args[0] === "worktree")
					stdout = registered
						? `worktree ${destination}\0HEAD ${head}\0branch refs/heads/feature\0\0`
						: "";
				else if (args[0] === "show-ref") exitCode = registered ? 0 : 1;
				else if (args[0] === "rev-parse")
					stdout = args.includes("--verify")
						? head
						: `${workspace.workspace.rootPath}\n${target.repositoryPath}\n`;
				return { stdout, stderr: "", exitCode };
			},
		});
		const request = {
			expectedRevision: 1,
			workspaceKey: "wk",
			requestId: "picker-service-fixture",
			destinationPath: destination,
			branch: { kind: "new" as const, name: "feature" },
		};
		const result = await service.create("user", "n", request, new AbortController().signal);
		expect(result.outcome).toBe("created");
		expect(result.worktree?.path).toBe(destination);
		expect(mkdir).not.toHaveBeenCalled();
		const collision = await service.create(
			"user",
			"n",
			{ ...request, requestId: "picker-existing", branch: { kind: "new", name: "other" } },
			new AbortController().signal,
		);
		expect(collision.outcome).toBe("failed");
		expect(collision.error?.code).toBe("WORKTREE_DESTINATION_EXISTS");
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
});
test.each([
	"existing",
	"../escape",
	"bad/name",
	"bad\\name",
	".",
	"..",
])("new target rejects %s and never overwrites/mkdirs", async (name) => {
	entries = [{ name: "existing", path: "/repo/existing", isDirectory: false }];
	await render();
	await input(name);
	await select();
	expect(selected).not.toHaveBeenCalled();
	expect(mkdir).not.toHaveBeenCalled();
	expect(container.textContent).toContain("never overwrite");
});
test.each([
	"C:\\repo",
	"\\\\host\\share",
	"/repo",
])("target retains parent %s path semantics", async (path) => {
	parent = path;
	await render();
	await input("new");
	await select();
	expect(selected.mock.calls[0]?.[0]).toBe(`${path}${path.startsWith("/") ? "/" : "\\"}new`);
	expect(mkdir).not.toHaveBeenCalled();
});
test.each([
	"CON",
	"NUL.txt",
	"tail.",
	"bad:name",
])("Windows invalid leaf %s cannot be selected", async (leaf) => {
	parent = "C:\\repo";
	await render();
	await input(leaf);
	await select();
	expect(selected).not.toHaveBeenCalled();
});
test("existing caller still selects an existing directory and mkdir still creates", async () => {
	await render("existing");
	await select();
	expect(selected.mock.calls[0]?.[0]).toBe("/repo");
	await act(async () => {
		(container.querySelector('[data-tooltip="newFolder"] button') as HTMLButtonElement).click();
		await flush();
	});
	await input("created-now");
	await act(async () => {
		[...container.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "create")
			?.click();
		await flush();
	});
	expect(mkdir).toHaveBeenCalledTimes(1);
	expect(directories.has("/repo/created-now")).toBe(true);
});
test("newTarget double click navigates parent, never selects an existing entry", async () => {
	entries = [{ name: "folder", path: "/repo/folder" }];
	await render();
	await act(async () => {
		const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.textContent === "folder",
		);
		button?.dispatchEvent(new window.Event("dblclick", { bubbles: true }));
		await flush();
	});
	expect(selected).not.toHaveBeenCalled();
	expect(browse.mock.calls.at(-1)?.[0]).toBe("/repo/folder");
	expect(mkdir).not.toHaveBeenCalled();
});
