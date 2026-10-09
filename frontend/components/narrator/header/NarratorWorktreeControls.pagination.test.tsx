import { afterAll, expect, mock, test } from "bun:test";
import type { WorktreeListQuery, WorktreeListResult } from "@shared/narrator-worktrees";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

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
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
mock.module("@frontend/hooks/useAuth", () => ({
	useCurrentUser: () => ({ data: { id: "user" } }),
}));
let workspaceKey = "workspace-one";
mock.module("@frontend/hooks/useWorkspaceContext", () => ({
	useWorkspaceContext: () => ({
		data: {
			revision: 1,
			deviceId: "local",
			cwd: "/repo",
			contextKey: "context",
			pathFlavor: "posix",
			git: { workspaceKey, repositoryKey: "repo", rootPath: "/repo" },
			capabilities: { switchDirectory: true },
		},
	}),
	useSwitchWorkspaceContext: () => ({ mutateAsync: async () => {}, isPending: false }),
}));
const requests: Array<{ workspaceKey: string; query: WorktreeListQuery }> = [];
mock.module("@frontend/lib/api", () => ({
	ApiError: class extends Error {},
	api: {
		listNarratorWorktrees: async (
			_id: string,
			key: string,
			_signal: AbortSignal,
			query: WorktreeListQuery,
		): Promise<WorktreeListResult> => {
			requests.push({ workspaceKey: key, query });
			const page = Number(query.cursor ?? 0);
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
						path: `/repo/${query.order}/${page}`,
						branch: "refs/heads/test",
						head: null,
						detached: false,
						locked: false,
						prunable: false,
					},
				],
			};
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
	Group: Wrapper,
	Stack: Wrapper,
	Tooltip: Wrapper,
	Text: Wrapper,
	Alert: Wrapper,
	Badge: Wrapper,
	Loader: Wrapper,
	ScrollArea: { Autosize: Wrapper },
	Modal: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div>{children}</div> : null,
	Collapse: Wrapper,
	Select: () => null,
	Textarea: () => null,
	TextInput: ({ value, onChange }: { value: string; onChange: (event: unknown) => void }) => (
		<input value={value} onInput={onChange} />
	),
}));
mock.module("../../common/DirectoryPicker", () => ({ DirectoryPicker: () => null }));
const { NarratorWorktreeControls } = await import("./NarratorWorktreeControls");

test("real QueryClient restarts at page one when revisiting sort, search or workspace conditions", async () => {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const flush = async () => {
		for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 2));
	};
	const render = () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<NarratorWorktreeControls narratorId="n" />
			</QueryClientProvider>,
		);
	const click = async (label: string) => {
		const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(node) => node.getAttribute("aria-label") === label || node.textContent === label,
		);
		if (!button) throw new Error(`Missing button ${label}`);
		await act(async () => {
			button.click();
			await flush();
		});
	};
	const fillPages = async () => {
		await click("worktree.loadMore");
		await click("worktree.loadMore");
		expect(container.querySelectorAll("[data-worktree-path]")).toHaveLength(3);
	};
	const assertFirstOnly = (start: number) => {
		expect(requests.slice(start)).toHaveLength(1);
		expect(requests[start]?.query.cursor).toBeUndefined();
		expect(container.querySelectorAll("[data-worktree-path]")).toHaveLength(1);
	};
	try {
		await act(async () => {
			render();
			await flush();
		});
		await click("worktree.switch");
		await fillPages();
		await click("worktree.descending");
		const sortStart = requests.length;
		await click("worktree.ascending");
		assertFirstOnly(sortStart);
		await fillPages();
		const search = async (text: string) => {
			await act(async () => {
				const input = container.querySelector("input");
				if (!input) throw new Error("Missing search input");
				input.value = text;
				input.dispatchEvent(new window.Event("input", { bubbles: true }));
			});
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 330));
			});
			// Settle the request launched by the debounced render, not just its timer.
			await act(flush);
		};
		await search("other");
		const searchStart = requests.length;
		await search("");
		assertFirstOnly(searchStart);
		await fillPages();
		workspaceKey = "workspace-two";
		await act(async () => {
			render();
			await flush();
		});
		const workspaceStart = requests.length;
		workspaceKey = "workspace-one";
		await act(async () => {
			render();
			await flush();
		});
		assertFirstOnly(workspaceStart);
	} finally {
		await act(async () => root.unmount());
		queryClient.clear();
		container.remove();
	}
});
