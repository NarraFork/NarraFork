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
const Wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const Button = ({
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
);
const create = mock((_input: Record<string, unknown>, _options?: unknown) => {});
const workspace = mock(async (_id: string) => ({
	revision: 5,
	contextKey: "remote:selected",
	deviceId: "remote",
	cwd: "C:\\selected repo",
	pathFlavor: "windows",
	capabilities: { switchDirectory: true },
}));
const legacy = mock(async () => ({ cwd: "/host-lure" }));
const chapter = mock(async () => ({ worktreePath: "/chapter-local" }));
const realApi = await import("../../lib/api");
mock.module("../../lib/api", () => ({
	...realApi,
	api: {
		...realApi.api,
		getSettings: async () => ({ paths: { defaultProjectDir: "/host-default" } }),
		listDevices: async () => [
			{ id: "remote", name: "Remote", status: "online", defaultCwd: "/executor-default" },
		],
		getWorkspaceContext: workspace,
		getNarrator: legacy,
		getChapter: chapter,
	},
}));
mock.module("../../hooks/useModels", () => ({ useAllModels: () => ({ groupedModels: [] }) }));
mock.module("../../hooks/useNarrator", () => ({
	useCreateNarrator: () => ({ mutate: create, isPending: false }),
	useArchiveNarrator: () => ({ mutate: () => {}, isPending: false }),
}));
mock.module("../../hooks/useFavoriteDirectories", () => ({
	useFavoriteDirectories: () => ({ data: [] }),
	useCreateFavoriteDirectory: () => ({ mutate: () => {} }),
	useDeleteFavoriteDirectory: () => ({ mutate: () => {} }),
	useReorderFavoriteDirectories: () => ({ mutate: () => {} }),
}));
mock.module("../common/DirectoryPicker", () => ({
	DirectoryPicker: ({
		value,
		onChange,
		deviceId,
	}: {
		value: string;
		onChange: (value: string) => void;
		deviceId: string;
	}) => (
		<input
			data-directory-device={deviceId}
			value={value}
			onInput={(event) => onChange(event.currentTarget.value)}
		/>
	),
}));
const translations = await import("react-i18next");
mock.module("react-i18next", () => ({
	...translations,
	useTranslation: () => ({ t: (key: string) => key }),
}));
const mantineHooks = await import("@mantine/hooks");
mock.module("@mantine/hooks", () => ({ ...mantineHooks, useMediaQuery: () => false }));
mock.module("@dnd-kit/core", () => ({
	DndContext: Wrapper,
	DragOverlay: Wrapper,
	useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
	closestCenter: () => {},
	PointerSensor: class {},
	useSensor: () => ({}),
	useSensors: () => [],
}));
mock.module("@dnd-kit/sortable", () => ({
	SortableContext: Wrapper,
	useSortable: () => ({
		attributes: {},
		listeners: {},
		setNodeRef: () => {},
		transform: null,
		isDragging: false,
	}),
	verticalListSortingStrategy: {},
}));
mock.module("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => undefined } } }));
const mantine = await import("@mantine/core");
mock.module("@mantine/core", () => ({
	...mantine,
	ActionIcon: Button,
	Divider: Wrapper,
	Group: Wrapper,
	ScrollArea: Wrapper,
	Stack: Wrapper,
	Text: Wrapper,
	Tooltip: Wrapper,
	Center: Wrapper,
	Loader: Wrapper,
	Paper: Wrapper,
	Box: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => (
		<div {...props}>{children}</div>
	),
	NavLink: ({
		label,
		children,
		onContextMenu,
	}: {
		label?: ReactNode;
		children?: ReactNode;
		onContextMenu?: import("react").MouseEventHandler<HTMLAnchorElement>;
	}) => (
		<a data-nav-link href="#source" onContextMenu={onContextMenu}>
			{label}
			{children}
		</a>
	),
	UnstyledButton: Button,
	Button,
	Modal: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div>{children}</div> : null,
	TextInput: () => null,
	Checkbox: () => null,
	Select: ({
		label,
		data,
		onChange,
	}: {
		label: string;
		data: Array<{ value: string; label: string; disabled?: boolean }>;
		onChange: (value: string) => void;
	}) => (
		<div data-select={label}>
			{data.map((option) => (
				<button
					type="button"
					key={option.value}
					disabled={option.disabled}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	),
}));
const notices = mock((_options: unknown) => {});
mock.module("@mantine/notifications", () => ({ notifications: { show: notices } }));
const router = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({
	...router,
	useNavigate: () => () => {},
	useRouterState: () => "/",
}));
const recent = await import("../../hooks/useRecentTabs");
let tab = {
	type: "narrator",
	id: "source",
	title: "Remote source",
	status: "idle",
	subtitle: "/host-lure",
};
const section = () => ({
	tabs: [tab],
	initialLoading: false,
	loadingMore: false,
	hasMore: false,
	error: null,
});
mock.module("../../hooks/useRecentTabs", () => ({
	...recent,
	useRecentTabs: () => ({
		work: section(),
		projects: { ...section(), tabs: [] },
		removeTab: () => {},
		moveTab: () => {},
		pinTab: () => {},
	}),
}));
mock.module("../../hooks/useUserPreferences", () => ({
	useUserPreferences: () => ({ data: { recentTabsGroupMode: "none" } }),
}));
mock.module("../../hooks/useCollapsedTabDirectories", () => ({
	useCollapsedTabDirectories: () => ({ isCollapsed: () => false, toggle: () => {} }),
}));
const platform = await import("../../hooks/usePlatform");
mock.module("../../hooks/usePlatform", () => ({
	...platform,
	useFsRevealCapability: () => ({ supported: false }),
}));
mock.module("../../hooks/useRecentTabKeyboardNav", () => ({ usePendingTabKey: () => null }));
mock.module("../../hooks/useSetupWizardGuard", () => ({ useSetupWizardGuard: () => () => true }));
mock.module("./useRecentTabsDrag", () => ({
	useRecentTabsDrag: () => ({
		pending: false,
		consumeClick: () => false,
		activeId: null,
		model: {
			topLevel: [tab],
			childrenByWorkspace: new Map(),
			pinnedItems: [],
			unpinnedItems: [tab],
			directoryRows: [{ kind: "tab", tab }],
		},
	}),
}));
mock.module("./useRecentTabExternalDrop", () => ({ useRecentTabExternalDrop: () => null }));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { RecentTabList } = await import("./RecentTabs");
let root: Root, host: HTMLElement, client: InstanceType<typeof QueryClient>;
async function flush() {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
beforeEach(() => {
	tab = {
		type: "narrator",
		id: "source",
		title: "Remote source",
		status: "idle",
		subtitle: "/host-lure",
	};
	create.mockClear();
	workspace.mockClear();
	legacy.mockClear();
	chapter.mockClear();
	notices.mockClear();
	workspace.mockImplementation(async () => ({
		revision: 5,
		contextKey: "remote:selected",
		deviceId: "remote",
		cwd: "C:\\selected repo",
		pathFlavor: "windows",
		capabilities: { switchDirectory: true },
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
async function mount() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<RecentTabList filter="narrator" />
			</QueryClientProvider>,
		),
	);
	await act(async () => {
		await flush();
	});
}
async function newHere() {
	const row = host.querySelector("[data-nav-link]");
	if (!row) throw new Error("production nav row missing");
	await act(async () => {
		row.dispatchEvent(
			Object.assign(new window.Event("contextmenu", { bubbles: true }), {
				clientX: 10,
				clientY: 20,
			}),
		);
	});
	const action = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
		(button) => button.textContent === "newNarratorHere",
	);
	if (!action) throw new Error("production context action missing");
	await act(async () => {
		action.click();
		await flush();
	});
	await act(async () => {
		await flush();
	});
}
async function submit() {
	await act(async () => {
		await flush();
	});
	await act(async () => {
		[...host.querySelectorAll<HTMLButtonElement>("button")]
			.find((button) => button.textContent === "createNarrator")
			?.click();
		await flush();
	});
}
test.each([
	"narrator",
	"subagent",
])("actual %s RecentTabs action opens actual create modal and submits the committed remote workspace target", async (type) => {
	tab = { ...tab, type };
	await mount();
	await newHere();
	expect(workspace).toHaveBeenCalledWith("source");
	expect(legacy).not.toHaveBeenCalled();
	expect(host.querySelector<HTMLInputElement>('input[data-directory-device="remote"]')?.value).toBe(
		"C:\\selected repo",
	);
	await submit();
	expect(create.mock.calls[0]?.[0].workspaceTarget).toEqual({
		deviceId: "remote",
		cwd: "C:\\selected repo",
	});
	expect(create.mock.calls[0]?.[0]).not.toHaveProperty("cwd");
});
test("failed context lookup cannot reuse legacy narrator.cwd or open a local creation modal", async () => {
	workspace.mockRejectedValue(new Error("offline initialization"));
	await mount();
	await newHere();
	await submit();
	expect(legacy).not.toHaveBeenCalled();
	expect(create).not.toHaveBeenCalled();
	expect(notices).toHaveBeenCalled();
});
test("chapter new-here remains explicitly local rather than inferring device from absolute path grammar", async () => {
	tab = { ...tab, type: "chapter" };
	await mount();
	await newHere();
	await submit();
	expect(workspace).not.toHaveBeenCalled();
	expect(create.mock.calls[0]?.[0].workspaceTarget).toEqual({
		deviceId: "local",
		cwd: "/chapter-local",
	});
});
