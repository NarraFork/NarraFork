/**
 * The project page route (R2) with its parts replaced by stand-ins: the header (name, pin, path
 * tail with the whole path, 「新会话」 / 「新团队」, the 「…」 menu's 项目设置), which parts mount
 * for a member and for a reader, the new-session and new-team flows, the PostgreSQL deployment
 * without teams, the outline's task board, and a failed project read.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

let canWrite = true;
let projectLoading = false;
let projectError = false;
let teamsRefused = false;
let outlineEnabled = false;
let phone = false;
let memberCount: { count: number; more: boolean } | undefined = { count: 4, more: false };
const openOutline = mock((_kind: string, _id: string) => {});
const navigate = mock(async (_value: unknown) => {});
const invalidate = mock(async (_value: unknown) => {});
const parts: { name: string; props: Record<string, unknown> }[] = [];
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const button = ({
	children,
	onClick,
	disabled,
	"data-testid": testId,
	"data-count": dataCount,
}: {
	children?: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	"data-testid"?: string;
	"data-count"?: number;
}) => (
	<button
		type="button"
		disabled={disabled}
		onClick={onClick}
		data-testid={testId}
		data-count={dataCount}
	>
		{children}
	</button>
);
const Menu = Object.assign(box, {
	Target: box,
	Dropdown: box,
	Divider: () => <hr />,
	Item: button,
});
mock.module("@mantine/core", () => ({
	ActionIcon: button,
	Alert: ({ children }: { children?: ReactNode }) => <div data-alert>{children}</div>,
	Box: box,
	Button: button,
	Group: box,
	Loader: () => <div data-loader />,
	Menu,
	Skeleton: () => <div data-skeleton />,
	Stack: box,
	Text: ({ children, "data-path": path }: { children?: ReactNode; "data-path"?: string }) => (
		<span data-path={path}>{children}</span>
	),
	Title: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
	UnstyledButton: button,
	Tooltip: ({ children, label }: { children?: ReactNode; label?: string }) => (
		<span data-tooltip={label}>{children}</span>
	),
}));
mock.module("@mantine/hooks", () => ({ useMediaQuery: () => phone }));
mock.module("@mantine/notifications", () => ({ notifications: { show: () => {} } }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: invalidate }),
}));
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: { component: ComponentType }) => ({
		options,
		useParams: () => ({ projectId: "original-project" }),
	}),
	useNavigate: () => navigate,
}));
mock.module("../../hooks/useProjects", () => ({
	useProject: () => ({
		isLoading: projectLoading,
		isError: projectError,
		data: projectLoading
			? undefined
			: {
					name: "acme-app",
					gitPath: "/home/me/code/acme-app",
					defaultBranch: "main",
					description: "The web app",
					canWrite,
				},
	}),
}));
const installAccessListener = mock(() => {});
mock.module("../../hooks/useProjectAccess", () => ({
	useProjectAccess: () => {
		throw new Error("The project page must not load every member");
	},
	installProjectAccessListener: installAccessListener,
	useProjectMemberCount: (projectId: string) => ({
		data: projectId === "original-project" ? memberCount : undefined,
	}),
}));
mock.module("../../hooks/useProjectOverview", () => ({
	useProjectTeamCards: () => ({
		isError: teamsRefused,
		error: teamsRefused ? { status: 503 } : null,
	}),
}));
mock.module("../../hooks/useTeams", () => ({
	teamsUnavailable: (error: { status?: number } | null) => error?.status === 503,
}));
mock.module("../../hooks/useOutline", () => ({
	useOutlineEnabled: () => ({ enabled: outlineEnabled, loading: false }),
	useOpenOutlineSpace: () => ({ open: openOutline, pending: false }),
}));
mock.module("../../lib/api-error", () => ({
	describeApiError: (error: unknown) => ({ message: String(error) }),
}));
mock.module("../../lib/outline-router", () => ({ useOpenOutlinePage: () => () => {} }));
mock.module("../nav/PinToSidebarButton", () => ({
	PinToSidebarButton: ({ type, id }: { type: string; id: string }) => (
		<span data-pin-to-sidebar={`${type}:${id}`} />
	),
}));
mock.module("../nav/MobileNavButton", () => ({
	MobileNavButton: () => <span data-mobile-nav-button />,
}));
const stub =
	(name: string) =>
	(props: Record<string, unknown>): ReactNode => {
		parts.push({ name, props });
		return <div data-part={name} />;
	};
mock.module("./ProjectAttention", () => ({ ProjectAttention: stub("attention") }));
mock.module("./ProjectTeamCards", () => ({ ProjectTeamCards: stub("teams") }));
mock.module("./ProjectSessions", () => ({ ProjectSessions: stub("sessions") }));
mock.module("../outline/task-board/TaskBoardViews", () => ({
	ProjectTaskBoard: ({ projectId }: { projectId: string }) => <div data-task-board={projectId} />,
	SessionTaskBoard: () => null,
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
mock.module("../teams/CreateTeamModal", () => ({
	CreateTeamModal: ({
		projectId,
		onCreated,
	}: {
		projectId: string;
		onCreated: (team: { id: string }) => void;
	}) => (
		<button type="button" data-team-project={projectId} onClick={() => onCreated({ id: "t1" })}>
			confirm-team
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
	projectLoading = false;
	projectError = false;
	teamsRefused = false;
	outlineEnabled = false;
	phone = false;
	memberCount = { count: 4, more: false };
	parts.length = 0;
	for (const fn of [navigate, invalidate, installAccessListener, openOutline]) fn.mockClear();
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
const byTestId = (id: string) =>
	container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null;
async function click(element: Element | null | undefined) {
	expect(element).toBeTruthy();
	await act(async () => element?.dispatchEvent(new window.Event("click", { bubbles: true })));
}
async function settle(selector: string) {
	for (let i = 0; i < 20 && !container.querySelector(selector); i++)
		await act(async () => await new Promise((resolve) => setTimeout(resolve, 5)));
}
const lastProps = (name: string) => parts.filter((part) => part.name === name).at(-1)?.props;

test("the header: name, pin, path tail with the whole path, branch, and the phone's menu button", async () => {
	await act(async () => root.render(<Page />));
	expect(container.querySelector("h2")?.textContent).toBe("acme-app");
	expect(
		container.querySelector('[data-pin-to-sidebar="project:original-project"]'),
	).not.toBeNull();
	const path = container.querySelector("[data-path]");
	expect(path?.textContent).toBe("…/code/acme-app");
	expect(path?.getAttribute("data-path")).toBe("/home/me/code/acme-app");
	expect(container.querySelector('[data-tooltip="/home/me/code/acme-app"]')).not.toBeNull();
	expect(container.textContent).toContain("main");
	// The page's own title row carries the phone menu button: nothing floats over the title.
	expect(container.querySelector("[data-mobile-nav-button]")).not.toBeNull();
	expect(installAccessListener).toHaveBeenCalledTimes(1);
});

test("a member gets 「等你处理」, team cards and sessions; the old folded settings are gone", async () => {
	await act(async () => root.render(<Page />));
	expect(lastProps("attention")).toMatchObject({ projectId: "original-project", enabled: true });
	expect(lastProps("teams")).toMatchObject({ projectId: "original-project", canCreate: true });
	expect(lastProps("sessions")).toMatchObject({ projectId: "original-project", phone: false });
	expect(container.querySelector("details")).toBeNull();
	expect(container.textContent).not.toContain("advancedSettings");
});

test("a reader: no 「等你处理」 read, creating disabled", async () => {
	canWrite = false;
	await act(async () => root.render(<Page />));
	expect(lastProps("attention")).toMatchObject({ enabled: false });
	expect(lastProps("teams")).toMatchObject({ canCreate: false });
	expect(byTestId("project-new-session")?.disabled).toBe(true);
	expect(byTestId("project-new-team")?.disabled).toBe(true);
});

test("新会话 starts in the project's directory, refreshes its sessions and opens the session", async () => {
	await act(async () => root.render(<Page />));
	await click(byTestId("project-new-session"));
	await settle("[data-project]");
	expect(
		container.querySelector('[data-project="original-project"][data-cwd="/home/me/code/acme-app"]'),
	).not.toBeNull();
	await click(
		Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent === "confirm-create",
		),
	);
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: ["narrators", "project", "original-project"],
	});
	expect(navigate).toHaveBeenCalledWith({
		to: "/narrators/$narratorId",
		params: { narratorId: "created" },
	});
});

test("新团队 opens the create-team dialog; the new team's page opens after", async () => {
	await act(async () => root.render(<Page />));
	await click(byTestId("project-new-team"));
	await settle("[data-team-project]");
	await click(container.querySelector('[data-team-project="original-project"]'));
	expect(navigate).toHaveBeenCalledWith({
		to: "/projects/$projectId/teams/$teamId",
		params: { projectId: "original-project", teamId: "t1" },
	});
});

test("「…」 → 项目设置 opens the settings page", async () => {
	await act(async () => root.render(<Page />));
	await click(byTestId("project-open-settings"));
	expect(navigate).toHaveBeenCalledWith({
		to: "/projects/$projectId/settings",
		params: { projectId: "original-project" },
	});
});

test("「N 位成员」 is a count from the server; it opens 成员与可见性", async () => {
	await act(async () => root.render(<Page />));
	const count = byTestId("project-member-count");
	expect(count?.getAttribute("data-count")).toBe("4");
	expect(count?.textContent).toBe("page.members");
	await click(count);
	expect(navigate).toHaveBeenCalledWith({
		to: "/projects/$projectId/settings",
		params: { projectId: "original-project" },
		hash: "settings-members",
	});
	// Past the server's limit it says 999+; unknown, it says nothing.
	memberCount = { count: 999, more: true };
	await act(async () => root.render(<Page key="more" />));
	expect(byTestId("project-member-count")?.textContent).toBe("page.membersMore");
	memberCount = undefined;
	await act(async () => root.render(<Page key="none" />));
	expect(byTestId("project-member-count")).toBeNull();
});

test("without teams on this deployment there is no 新团队", async () => {
	teamsRefused = true;
	await act(async () => root.render(<Page />));
	expect(byTestId("project-new-team")).toBeNull();
	expect(byTestId("project-new-session")).not.toBeNull();
});

test("a failed project read shows one alert and nothing that could act", async () => {
	projectError = true;
	await act(async () => root.render(<Page />));
	expect(container.textContent).toContain("compatibility.unavailable");
	expect(container.querySelector("button")).toBeNull();
	expect(parts).toHaveLength(0);
});

test("loading keeps the shell: a skeleton title, creation disabled", async () => {
	projectLoading = true;
	await act(async () => root.render(<Page />));
	expect(container.querySelector("[data-skeleton]")).not.toBeNull();
	expect(container.querySelector("[data-pin-to-sidebar]")).toBeNull();
	expect(byTestId("project-new-session")?.disabled).toBe(true);
});

test("with the outline on, the menu opens the outline and swaps in the task board", async () => {
	await act(async () => root.render(<Page />));
	expect(container.textContent).not.toContain("openOutline");
	outlineEnabled = true;
	await act(async () => root.render(<Page />));
	await click(
		Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "openOutline"),
	);
	expect(openOutline).toHaveBeenCalledWith("project", "original-project");
	await click(byTestId("project-toggle-tasks"));
	await settle("[data-task-board]");
	expect(container.querySelector('[data-task-board="original-project"]')).not.toBeNull();
	expect(container.querySelector('[data-part="sessions"]')).toBeNull();
	await click(byTestId("project-toggle-tasks"));
	expect(container.querySelector("[data-task-board]")).toBeNull();
	expect(container.querySelector('[data-part="sessions"]')).not.toBeNull();
});

test("on a phone the parts get the phone layout", async () => {
	phone = true;
	await act(async () => root.render(<Page />));
	expect(lastProps("attention")).toMatchObject({ phone: true });
	expect(lastProps("sessions")).toMatchObject({ phone: true });
});
