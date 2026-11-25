import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { WorktreeListQuery, WorktreeListResult } from "@shared/narrator-worktrees";
import { type InfiniteData, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { NarratorPanelVisibilityProvider } from "../narrator-panel-visibility";

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
const storage = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
	value: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => storage.set(key, value),
		removeItem: (key: string) => storage.delete(key),
	},
	configurable: true,
});
let documentVisible = true;
Object.defineProperty(document, "visibilityState", {
	get: () => (documentVisible ? "visible" : "hidden"),
	configurable: true,
});
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
let userId = "user";
let credential = 1;
const credentialListeners = new Set<() => void>();
mock.module("@frontend/hooks/useAuth", () => ({
	useCurrentUser: () => ({ data: { id: userId } }),
}));
mock.module("@frontend/lib/narrator-ws-manager", () => ({
	narratorWSManager: {
		onCredentialChange: (listener: () => void) => {
			credentialListeners.add(listener);
			return () => credentialListeners.delete(listener);
		},
		getCredentialIdentity: () => credential,
	},
}));
let workspaceKey = "workspace-one";
let deviceId = "local";
let repositoryKey = "repo";
let canSwitch = true;
mock.module("@frontend/hooks/useWorkspaceContext", () => ({
	useWorkspaceContext: () => ({
		data: {
			revision: 1,
			deviceId,
			cwd: "/repo",
			contextKey: "context",
			pathFlavor: "posix",
			git: { workspaceKey, repositoryKey, rootPath: "/repo" },
			capabilities: { switchDirectory: canSwitch },
		},
	}),
	useSwitchWorkspaceContext: () => ({ mutateAsync: async () => {}, isPending: false }),
	workspaceContextKey: (id: string) => ["workspaceContext", id],
}));
class FakeApiError extends Error {
	readonly data = { code: "WORKTREE_CURSOR_EXPIRED" };
}
type Request = {
	workspaceKey: string;
	query: WorktreeListQuery;
	signal: AbortSignal;
	userId: string;
	credential: number;
};
const requests: Request[] = [];
const pageResult = (request: Request): WorktreeListResult => {
	const page = Number(request.query.cursor ?? 0);
	return {
		repositoryKey: "repo",
		truncated: false,
		hasMore: page < 2,
		nextCursor: page < 2 ? String(page + 1) : null,
		capabilities: {
			list: true,
			create: true,
			switch: false,
			delete: false,
			prune: false,
			remote: false,
		},
		entries: [
			{
				path: `/repo/${request.userId}/${request.credential}/${request.query.order}/${page}`,
				branch: "refs/heads/test",
				head: null,
				detached: false,
				locked: false,
				prunable: false,
			},
		],
	};
};
let respond: (request: Request) => Promise<WorktreeListResult> = async (request) =>
	pageResult(request);
mock.module("@frontend/lib/api", () => ({
	ApiError: FakeApiError,
	api: {
		listNarratorWorktrees: (
			_id: string,
			key: string,
			signal: AbortSignal,
			query: WorktreeListQuery,
		): Promise<WorktreeListResult> => {
			const request = { workspaceKey: key, query, signal, userId, credential };
			requests.push(request);
			return respond(request);
		},
	},
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const Wrapper = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const Button = ({
	children,
	onClick,
	disabled,
	"aria-label": label,
	"data-worktree-path": path,
}: {
	children?: ReactNode;
	onClick?: () => void;
	disabled?: boolean;
	"aria-label"?: string;
	"data-worktree-path"?: string;
}) => (
	<button
		type="button"
		aria-label={label}
		data-worktree-path={path}
		onClick={onClick}
		disabled={disabled}
	>
		{children}
	</button>
);
mock.module("@mantine/core", () => ({
	ActionIcon: Button,
	Button,
	UnstyledButton: Button,
	Group: Wrapper,
	Stack: Wrapper,
	Tooltip: Wrapper,
	Text: Wrapper,
	Alert: Wrapper,
	Badge: Wrapper,
	Loader: Wrapper,
	Divider: () => null,
	Checkbox: () => null,
	ScrollArea: { Autosize: Wrapper },
	Modal: ({
		opened,
		children,
		onClose,
		title,
	}: {
		opened: boolean;
		children?: ReactNode;
		onClose: () => void;
		title: string;
	}) =>
		opened ? (
			<div>
				<button type="button" aria-label={`close:${title}`} onClick={onClose}>
					Close
				</button>
				{children}
			</div>
		) : null,
	Collapse: Wrapper,
	Select: ({
		onChange,
		data,
	}: {
		onChange: (value: string) => void;
		data: Array<{ value: string; label: string }>;
	}) => (
		<div>
			{data.map((option) => (
				<button
					type="button"
					key={option.value}
					aria-label={`sort:${option.value}`}
					onClick={() => onChange(option.value)}
				>
					{option.label}
				</button>
			))}
		</div>
	),
	Textarea: () => null,
	TextInput: ({ value, onChange }: { value: string; onChange: (event: unknown) => void }) => (
		<input value={value} onInput={onChange} />
	),
}));
mock.module("../../common/DirectoryPicker", () => ({ DirectoryPicker: () => null }));
const { NarratorWorktreeControls } = await import("./NarratorWorktreeControls");
type Pages = InfiniteData<WorktreeListResult, string | undefined>;
const flush = async () => {
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 2));
};
const settle = async (action: () => unknown) => {
	await act(async () => {
		action();
		await flush();
	});
	// Effects can start a query only when act commits the render above.
	await act(flush);
};
const deferred = <T,>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
let cleanup: (() => Promise<void>) | undefined;
beforeEach(() => {
	requests.length = 0;
	storage.clear();
	userId = "user";
	credential = 1;
	workspaceKey = "workspace-one";
	deviceId = "local";
	repositoryKey = "repo";
	canSwitch = true;
	documentVisible = true;
	respond = async (request) => pageResult(request);
});
afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});
async function fixture() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const container = document.createElement("div");
	document.body.appendChild(container);
	let root = createRoot(container);
	let mounted = true;
	let panelVisible = true;
	const render = () =>
		root.render(
			<QueryClientProvider client={client}>
				<NarratorPanelVisibilityProvider value={panelVisible}>
					<NarratorWorktreeControls narratorId="n" canCreateWorktree />
				</NarratorPanelVisibilityProvider>
			</QueryClientProvider>,
		);
	const button = (label: string) => {
		const node = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.getAttribute("aria-label") === label || node.textContent === label,
		);
		if (!node) throw new Error(`Missing button ${label}`);
		return node;
	};
	const click = (label: string) => settle(() => button(label).click());
	const unmount = async () => {
		await settle(() => root.unmount());
		mounted = false;
	};
	cleanup = async () => {
		if (mounted) await unmount();
		client.clear();
		container.remove();
	};
	await settle(render);
	return {
		client,
		container,
		button,
		click,
		open: () => click("worktree.switch"),
		close: () => click("close:worktree.switch"),
		rerender: () => settle(render),
		unmount,
		remount: async () => {
			root = createRoot(container);
			mounted = true;
			await settle(render);
		},
		setPanelVisible: (value: boolean) =>
			settle(() => {
				panelVisible = value;
				render();
			}),
		setDocumentVisible: (value: boolean) =>
			settle(() => {
				documentVisible = value;
				document.dispatchEvent(new window.Event("visibilitychange"));
			}),
		search: async (text: string) => {
			await settle(() => {
				const input = container.querySelector("input");
				if (!input) throw new Error("Missing search input");
				input.value = text;
				input.dispatchEvent(new window.Event("input", { bubbles: true }));
			});
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 310));
			});
			await act(flush);
		},
		fillPages: async () => {
			await click("worktree.loadMore");
			await click("worktree.loadMore");
			expect(container.querySelectorAll("[data-worktree-path]")).toHaveLength(3);
		},
	};
}
const listQueries = (client: QueryClient) =>
	client.getQueryCache().findAll({ queryKey: ["narratorWorktrees"] });
const expectFirstPage = (client: QueryClient) => {
	for (const query of listQueries(client)) {
		const data = query.state.data as Pages | undefined;
		if (data) {
			expect(data.pages).toHaveLength(1);
			expect(data.pageParams).toEqual([undefined]);
		}
	}
};

test("closed and cold create form do not list worktrees; first list open fetches exactly one page", async () => {
	const ui = await fixture();
	expect(requests).toHaveLength(0);
	expect(ui.button("worktree.quickCreate").disabled).toBe(false);
	await ui.click("worktree.quickCreate");
	expect(requests).toHaveLength(0);
	await ui.open();
	expect(requests).toHaveLength(1);
	expect(requests[0]?.query.cursor).toBeUndefined();
	expect(ui.container.textContent).not.toContain("worktree.receiptStorage");
});

test("close trims three pages and fresh reopen plus unmount/remount make no additional GET", async () => {
	const ui = await fixture();
	await ui.open();
	await ui.fillPages();
	expect(requests).toHaveLength(3);
	const updatedAt = listQueries(ui.client)[0]?.state.dataUpdatedAt;
	await ui.close();
	expectFirstPage(ui.client);
	expect(listQueries(ui.client)[0]?.state.dataUpdatedAt).toBe(updatedAt);
	await ui.open();
	expect(requests).toHaveLength(3);
	expect(ui.container.querySelectorAll("[data-worktree-path]")).toHaveLength(1);
	await ui.fillPages();
	expect(requests).toHaveLength(5);
	await ui.unmount();
	expectFirstPage(ui.client);
	await ui.remount();
	expect(requests).toHaveLength(5);
	await ui.open();
	expect(requests).toHaveLength(5);
	expectFirstPage(ui.client);
});

test("expired reopen refetches only the first page without replaying the old cursor chain", async () => {
	const ui = await fixture();
	await ui.open();
	await ui.fillPages();
	await ui.close();
	const query = listQueries(ui.client)[0];
	if (!query) throw new Error("Missing cached list");
	query.setState({ dataUpdatedAt: Date.now() - 31_000 });
	await ui.open();
	expect(requests).toHaveLength(4);
	expect(requests[3]?.query.cursor).toBeUndefined();
	expectFirstPage(ui.client);
});

test("fresh sort, search and workspace revisits reuse only their first page with zero extra GET", async () => {
	const ui = await fixture();
	await ui.open();
	await ui.fillPages();
	await ui.click("worktree.descending");
	expect(requests).toHaveLength(4);
	await ui.click("worktree.ascending");
	expect(requests).toHaveLength(4);
	expectFirstPage(ui.client);
	await ui.fillPages();
	await ui.search("other");
	expect(requests).toHaveLength(7);
	await ui.search("");
	expect(requests).toHaveLength(7);
	expectFirstPage(ui.client);
	await ui.fillPages();
	workspaceKey = "workspace-two";
	await ui.rerender();
	expect(requests).toHaveLength(10);
	workspaceKey = "workspace-one";
	await ui.rerender();
	expect(requests).toHaveLength(10);
	expectFirstPage(ui.client);
});

for (const boundary of [
	"close",
	"panel",
	"document",
	"credential",
	"workspace",
	"principal",
	"repository",
	"device",
	"unmount",
] as const) {
	test(`${boundary} cancels an in-flight request and a late response cannot populate its cache`, async () => {
		const pending = deferred<WorktreeListResult>();
		respond = () => pending.promise;
		const ui = await fixture();
		await ui.open();
		expect(requests).toHaveLength(1);
		const request = requests[0];
		if (!request) throw new Error("Missing pending request");
		const oldQuery = listQueries(ui.client)[0];
		if (!oldQuery) throw new Error("Missing old query");
		respond = async (request) => pageResult(request);
		if (boundary === "close") await ui.close();
		if (boundary === "panel") await ui.setPanelVisible(false);
		if (boundary === "document") await ui.setDocumentVisible(false);
		if (boundary === "unmount") await ui.unmount();
		if (boundary === "credential") {
			await settle(() => {
				credential = 2;
				for (const listener of credentialListeners) listener();
			});
		}
		if (boundary === "workspace") {
			workspaceKey = "workspace-two";
			await ui.rerender();
		}
		if (boundary === "principal" || boundary === "repository" || boundary === "device") {
			if (boundary === "principal") userId = "another-user";
			if (boundary === "repository") repositoryKey = "another-repository";
			if (boundary === "device") deviceId = "remote";
			await ui.rerender();
		}
		expect(request.signal.aborted).toBe(true);
		const expected = boundary === "credential" || boundary === "workspace" ? 2 : 1;
		expect(requests).toHaveLength(expected);
		await settle(() => pending.resolve(pageResult(request)));
		expect(requests).toHaveLength(expected);
		expect(oldQuery.state.data).toBeUndefined();
		if (boundary === "credential") {
			const current = listQueries(ui.client).find((query) => query.queryKey.at(-1) === 2);
			expect((current?.state.data as Pages).pages[0]?.entries[0]?.path).toContain("/user/2/");
			expect(ui.container.textContent).not.toContain("/user/1/");
		}
	});
}

test("a visible cursor expiry recovers with exactly one first-page request", async () => {
	const ui = await fixture();
	await ui.open();
	respond = async (request) => {
		if (request.query.cursor) throw new FakeApiError("expired");
		return pageResult(request);
	};
	await ui.click("worktree.loadMore");
	expect(requests.map((request) => request.query.cursor)).toEqual([undefined, "1", undefined]);
	expectFirstPage(ui.client);
});

test("cached cursor expiry does not recover while closed, then opening recovers only once", async () => {
	const ui = await fixture();
	await ui.open();
	await ui.fillPages();
	await ui.close();
	const query = listQueries(ui.client)[0];
	if (!query) throw new Error("Missing query");
	await settle(() => query.setState({ error: new FakeApiError("expired"), status: "error" }));
	expect(requests).toHaveLength(3);
	await ui.open();
	expect(requests).toHaveLength(4);
	expect(requests[3]?.query.cursor).toBeUndefined();
	expectFirstPage(ui.client);
});

test("principal and credential have isolated caches, and returning to a fresh principal reuses its first page", async () => {
	const ui = await fixture();
	await ui.open();
	await ui.fillPages();
	userId = "other-user";
	await ui.rerender();
	expect(requests).toHaveLength(3);
	await ui.open();
	expect(requests).toHaveLength(4);
	expect(
		ui.container.querySelector("[data-worktree-path]")?.getAttribute("data-worktree-path"),
	).toContain("/other-user/1/");
	userId = "user";
	await ui.rerender();
	await ui.open();
	expect(requests).toHaveLength(4);
	expectFirstPage(ui.client);
	await settle(() => {
		credential = 2;
		for (const listener of credentialListeners) listener();
	});
	expect(requests).toHaveLength(5);
	expect(
		ui.container.querySelector("[data-worktree-path]")?.getAttribute("data-worktree-path"),
	).toContain("/user/2/");
	expect(listQueries(ui.client)).toHaveLength(3);
});

for (const condition of ["sort", "search", "workspace"] as const) {
	test(`expired ${condition} revisit requests one first page, never all three saved pages`, async () => {
		const ui = await fixture();
		await ui.open();
		await ui.fillPages();
		const original = listQueries(ui.client)[0];
		if (!original) throw new Error("Missing original query");
		if (condition === "sort") await ui.click("sort:name");
		if (condition === "search") await ui.search("other");
		if (condition === "workspace") {
			workspaceKey = "workspace-two";
			await ui.rerender();
		}
		expect(requests).toHaveLength(4);
		expect((original.state.data as Pages).pages).toHaveLength(1);
		original.setState({ dataUpdatedAt: Date.now() - 31_000 });
		if (condition === "sort") await ui.click("sort:lastCommitAt");
		if (condition === "search") await ui.search("");
		if (condition === "workspace") {
			workspaceKey = "workspace-one";
			await ui.rerender();
		}
		expect(requests).toHaveLength(5);
		expect(requests[4]?.query.cursor).toBeUndefined();
		expectFirstPage(ui.client);
	});
}

test("closing during a fourth-page fetch cancels it, trims rollback pages, and ignores late expiry", async () => {
	const ui = await fixture();
	await ui.open();
	// Keep the snapshot pageable after the third page, then hold the fourth request open.
	respond = async (request) => ({
		...pageResult(request),
		hasMore: true,
		nextCursor: String(Number(request.query.cursor ?? 0) + 1),
	});
	await ui.fillPages();
	const pending = deferred<WorktreeListResult>();
	respond = () => pending.promise;
	await ui.click("worktree.loadMore");
	expect(requests).toHaveLength(4);
	expect(requests[3]?.query.cursor).toBe("3");
	await ui.close();
	expect(requests[3]?.signal.aborted).toBe(true);
	expectFirstPage(ui.client);
	await settle(() => pending.reject(new FakeApiError("late expired cursor")));
	expect(requests).toHaveLength(4);
	expect(listQueries(ui.client)[0]?.state.error).toBeNull();
	await ui.open();
	expect(requests).toHaveLength(4);
	expectFirstPage(ui.client);
});

test("unsupported or hidden cold views never load a list", async () => {
	canSwitch = false;
	const ui = await fixture();
	expect(ui.button("worktree.switch").disabled).toBe(true);
	expect(requests).toHaveLength(0);
	canSwitch = true;
	await ui.rerender();
	await ui.setPanelVisible(false);
	await ui.open();
	expect(requests).toHaveLength(0);
	await ui.setPanelVisible(true);
	expect(requests).toHaveLength(1);
});
