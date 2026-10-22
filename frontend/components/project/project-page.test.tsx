import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

let canWrite = true;
let projectError = false;
let settingsError = false;
const navigate = mock(async (_value: unknown) => {});
const invalidate = mock(async (_value: unknown) => {});
const fetchNextPage = mock(async () => {});
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@mantine/core", () => ({
	Alert: box,
	Card: box,
	Group: box,
	Stack: box,
	Text: box,
	Title: box,
	Loader: () => <div data-loader />,
	Button: ({
		children,
		onClick,
		disabled,
	}: {
		children?: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
	}) => (
		<button type="button" disabled={disabled} onClick={onClick}>
			{children}
		</button>
	),
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: invalidate }),
	useInfiniteQuery: (options: {
		queryFn: (arg: { pageParam?: string }) => unknown;
		getNextPageParam: (page: { nextCursor?: string }) => unknown;
		enabled: boolean;
	}) => {
		expect(options.getNextPageParam({ nextCursor: "next" })).toBe("next");
		if (options.enabled) void options.queryFn({ pageParam: "cursor" });
		return {
			isLoading: false,
			isError: false,
			isSuccess: true,
			hasNextPage: true,
			fetchNextPage,
			data: {
				pages: [
					{
						items: [
							{ id: "old-session", title: "Old session", cwd: "/old-worktree" },
							{ id: "new-session", title: "New session", cwd: "/project-directory" },
						],
					},
				],
			},
		};
	},
}));
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: { component: ComponentType }) => ({
		options,
		useParams: () => ({ projectId: "original-project" }),
	}),
	useNavigate: () => navigate,
	Link: ({
		to,
		params,
		children,
	}: {
		to: string;
		params: { narratorId?: string };
		children?: ReactNode;
	}) => <a href={to.replace("$narratorId", params.narratorId ?? "")}>{children}</a>,
}));
mock.module("../../hooks/useProjects", () => ({
	useProject: () => ({
		isLoading: false,
		isError: projectError,
		data: {
			name: "My project",
			gitPath: "/project-directory",
			description: "Description",
			canWrite,
		},
	}),
}));
const fullAccess = mock(() => {
	throw new Error("Default page must not load all members");
});
const installAccessListener = mock(() => {});
mock.module("../../hooks/useProjectAccess", () => ({
	useProjectAccess: fullAccess,
	installProjectAccessListener: installAccessListener,
}));
const list = mock(async (_options: unknown) => ({}));
mock.module("../../lib/api", () => ({ api: { listNarratorsPaginated: list } }));
mock.module("./ProjectSettingsPanel", () => ({
	ProjectSettingsPanel: () => {
		if (settingsError) throw new Error("optional settings failed");
		return <div data-settings />;
	},
}));
mock.module("../narrator/CreateNarratorModal", () => ({
	CreateNarratorModal: ({
		contextProjectId,
		initialCwd,
		onCreated,
	}: {
		contextProjectId: string;
		initialCwd: string;
		onCreated: (value: { id: string }) => void;
	}) => (
		<button
			type="button"
			data-project={contextProjectId}
			data-cwd={initialCwd}
			onClick={() => onCreated({ id: "created" })}
		>
			confirm-create
		</button>
	),
}));
const { Route } = await import("../../routes/projects/$projectId");
const Page = Route.options.component as ComponentType;
let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	canWrite = true;
	projectError = false;
	settingsError = false;
	for (const fn of [
		navigate,
		invalidate,
		fetchNextPage,
		list,
		fullAccess,
		installAccessListener,
	])
		fn.mockClear();
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
async function openDetails(index: number) {
	const details = container.querySelectorAll("details")[index];
	await act(async () => {
		details.open = true;
		details.dispatchEvent(new window.Event("toggle"));
	});
}
test("project shows directory and sessions, but does not mount tools on read", async () => {
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("My project");
	expect(container.textContent).toContain("/project-directory");
	expect(container.textContent).toContain("Description");
	expect(container.querySelector('a[href="/narrators/old-session"]')).not.toBeNull();
	expect(container.querySelector('a[href="/narrators/new-session"]')).not.toBeNull();
	expect(container.textContent).not.toContain("compatibility.retirement");
	expect(fullAccess).not.toHaveBeenCalled();
	expect(installAccessListener).toHaveBeenCalledTimes(1);
	expect(container.querySelector("[data-settings]")).toBeNull();
	expect(container.querySelector("[data-project]")).toBeNull();
	expect(list).toHaveBeenCalledWith({
		standalone: "all",
		projectId: "original-project",
		limit: 30,
		cursor: "cursor",
	});
	await click("compatibility.loadMore");
	expect(fetchNextPage).toHaveBeenCalledTimes(1);
});
test("write-only members can create with explicit project/default cwd then invalidate and navigate", async () => {
	await act(async () => root.render(<Page />));
	await click("newSession");
	expect(
		container.querySelector('[data-project="original-project"][data-cwd="/project-directory"]'),
	).not.toBeNull();
	await click("confirm-create");
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: ["narrators", "project", "original-project"],
	});
	expect(navigate).toHaveBeenCalledWith({
		to: "/narrators/$narratorId",
		params: { narratorId: "created" },
	});
});
test("read-only project summary disables creation", async () => {
	canWrite = false;
	await act(async () => root.render(<Page />));
	expect(container.querySelector("button")?.disabled).toBe(true);
	await click("newSession");
	expect(container.querySelector("[data-project]")).toBeNull();
});
test("failed project refresh never authorizes creating from a stale writable summary", async () => {
	await act(async () => root.render(<Page />));
	await click("newSession");
	expect(container.querySelector("[data-project]")).not.toBeNull();
	projectError = true;
	list.mockClear();
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("compatibility.unavailable");
	expect(container.querySelector("button")).toBeNull();
	expect(container.querySelector("[data-project]")).toBeNull();
	expect(list).not.toHaveBeenCalled();
});
test("optional settings render failure stays local to the expanded section", async () => {
	settingsError = true;
	await act(async () => root.render(<Page />));
	await openDetails(0);
	expect(container.textContent).toContain("compatibility.unavailable");
	expect(container.textContent).toContain("My project");
	expect(container.querySelector('a[href="/narrators/new-session"]')).not.toBeNull();
});
