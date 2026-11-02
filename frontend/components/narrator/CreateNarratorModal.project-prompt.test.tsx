/**
 * The new-session dialog's project-prompt box.
 *
 * What is worth pinning is the ORDER the two writes happen in, and what happens when
 * the first one is refused:
 *
 *  - the prompt file is saved BEFORE the narrator is created. Creating first would
 *    leave a session whose prompt was never written, with an error and nothing to
 *    retry;
 *  - a save the server refuses (409 stale) aborts the create. Silently creating the
 *    session anyway is the failure that looks like success;
 *  - an UNCHANGED box writes nothing at all, so opening the dialog and pressing create
 *    never touches a file the user did not edit.
 *
 * The box is not a per-session system prompt: it edits the file `narrator-prompt`
 * already injects for the directory, which is why the flow is "file first".
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const create = mock(() => {});
const saveProjectPrompt = mock(async (_input: unknown) => ({
	ok: true as const,
	path: "/ws/AGENTS.md",
	filename: "AGENTS.md",
	hash: "hash-after-save",
}));
const showNotification = mock(() => {});

let promptQuery: {
	data?: {
		cwd: string;
		filename: string;
		path: string;
		exists: boolean;
		content: string;
		truncated: boolean;
		totalBytes: number | null;
		hash: string | null;
		candidates: string[];
	};
	isPending?: boolean;
	isFetching?: boolean;
	isError?: boolean;
	error?: unknown;
};

const textareaProps: Array<Record<string, unknown>> = [];

mock.module("@mantine/core", () => {
	const pass = (name: string) => (props: Record<string, unknown>) => {
		const { children, ...rest } = props as { children?: unknown };
		return (
			<div data-part={name} {...rest}>
				{children as never}
			</div>
		);
	};
	const Textarea = (props: Record<string, unknown>) => {
		textareaProps.push(props);
		return <div data-part="textarea" />;
	};
	return {
		ActionIcon: pass("action-icon"),
		Button: (props: { children?: unknown; onClick?: () => void }) => (
			<button type="button" onClick={props.onClick}>
				{props.children as never}
			</button>
		),
		Checkbox: pass("checkbox"),
		Divider: pass("divider"),
		Group: pass("group"),
		Menu: Object.assign(pass("menu"), {
			Target: pass("menu-target"),
			Dropdown: pass("menu-dropdown"),
			Label: pass("menu-label"),
			Item: pass("menu-item"),
			Divider: pass("menu-divider"),
		}),
		NumberInput: pass("number-input"),
		Modal: pass("modal"),
		ScrollArea: pass("scroll-area"),
		Select: pass("select"),
		Stack: pass("stack"),
		Text: pass("text"),
		Textarea,
		TextInput: pass("text-input"),
		Tooltip: pass("tooltip"),
	};
});
mock.module("@mantine/hooks", () => ({ useMediaQuery: () => false }));
mock.module("@mantine/notifications", () => ({ notifications: { show: showNotification } }));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@tanstack/react-query", () => ({
	useQuery: (options: { queryKey: unknown[] }) =>
		options.queryKey[0] === "project-prompt" ? promptQuery : { data: { agent: {} } },
	useQueryClient: () => ({ invalidateQueries: mock(() => {}) }),
}));
mock.module("../../hooks/useModels", () => ({ useAllModels: () => ({ groupedModels: [] }) }));
mock.module("../../hooks/useProjectDirStatus", () => ({
	useProjectDirStatus: () => ({ usablePath: "/ws", needsChoice: false, isLoading: false }),
}));
mock.module("../../hooks/useNarrator", () => ({
	useCreateNarrator: () => ({ mutate: create, isPending: false }),
}));
// The dialog offers "insert from prompt library" next to the project-prompt box. The
// library itself is covered by its own tests, so this file only needs an empty one —
// mocking the hook (like every other collaborator here) keeps the component's internal
// query/mutation wiring out of this test's surface.
mock.module("../../hooks/usePromptLibrary", () => ({
	usePromptLibrary: () => ({ data: [], isLoading: false }),
	useCreatePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
	useUpdatePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
	useDeletePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
}));
const idleMutation = { mutate: mock(() => {}), reset: mock(() => {}), isPending: false };
mock.module("../../hooks/useFavoriteDirectories", () => ({
	useFavoriteDirectories: () => ({ data: [] }),
	useCreateFavoriteDirectory: () => idleMutation,
	useDeleteFavoriteDirectory: () => idleMutation,
	useReorderFavoriteDirectories: () => idleMutation,
}));
mock.module("../../hooks/useGitIdentityVisibility", () => ({
	useGitIdentityVisibility: () => ({
		contextMenu: false,
		createModal: false,
		setContextMenu: () => {},
		setCreateModal: () => {},
	}),
}));
mock.module("../../hooks/useGitIdentities", () => ({
	useGitIdentities: () => ({ data: [], isLoading: false, isError: false }),
	narratorGitIdentityQueryKey: (id: string) => ["auth", "git-identities", "narrator", id],
}));
mock.module("../../lib/api", () => ({
	api: {
		getSettings: mock(() => {}),
		// Only the project-prompt read is provided; the dialog must not need another.
		getProjectPrompt: () => promptQuery,
		saveProjectPrompt,
	},
}));
mock.module("../common/DirectoryPicker", () => ({
	DirectoryPicker: () => <div data-part="directory-picker" />,
}));

const { CreateNarratorModal } = await import("./CreateNarratorModal");

let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	promptQuery = {
		data: {
			cwd: "/ws",
			filename: "AGENTS.md",
			path: "/ws/AGENTS.md",
			exists: true,
			content: "# 旧内容\n",
			truncated: false,
			totalBytes: 10,
			hash: "hash-before",
			candidates: ["AGENTS.override.md", "AGENTS.md", "AGENT.md", "CLAUDE.md"],
		},
	};
	textareaProps.length = 0;
	create.mockClear();
	showNotification.mockClear();
	saveProjectPrompt.mockClear();
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

function promptBox() {
	return textareaProps.at(-1) as
		| {
				value?: string;
				readOnly?: boolean;
				onChange?: (e: { currentTarget: { value: string } }) => void;
		  }
		| undefined;
}

async function renderDialog() {
	await act(async () => root.render(<CreateNarratorModal opened onClose={() => {}} />));
}

async function clickCreate() {
	const button = Array.from(container.querySelectorAll("button")).find(
		(node) => node.textContent === "createNarrator",
	);
	expect(button).toBeDefined();
	await act(async () => {
		button?.dispatchEvent(new window.Event("click", { bubbles: true }));
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("project prompt box", () => {
	test("shows the file content it loaded", async () => {
		await renderDialog();
		expect(promptBox()?.value).toBe("# 旧内容\n");
	});

	test("an unchanged box writes nothing and creates the session", async () => {
		await renderDialog();
		await clickCreate();
		expect(saveProjectPrompt).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
	});

	test("an edit is saved before the narrator is created", async () => {
		await renderDialog();
		await act(async () => {
			promptBox()?.onChange?.({ currentTarget: { value: "# 新内容\n" } });
		});
		await clickCreate();

		expect(saveProjectPrompt).toHaveBeenCalledTimes(1);
		const savedInput = (saveProjectPrompt.mock.calls as unknown[][])[0]?.[0];
		expect(savedInput).toMatchObject({
			cwd: "/ws",
			filename: "AGENTS.md",
			content: "# 新内容\n",
			// The lock is the hash that was loaded, not a blind overwrite.
			baseHash: "hash-before",
		});
		expect(create).toHaveBeenCalledTimes(1);
	});

	test("a refused save aborts the create and keeps the dialog open", async () => {
		saveProjectPrompt.mockImplementationOnce(async () => {
			throw new Error("The prompt file changed since it was opened");
		});
		await renderDialog();
		await act(async () => {
			promptBox()?.onChange?.({ currentTarget: { value: "# 新内容\n" } });
		});
		await clickCreate();

		expect(create).not.toHaveBeenCalled();
		expect(showNotification).toHaveBeenCalledTimes(1);
		const shown = (showNotification.mock.calls as unknown[][])[0]?.[0];
		expect(shown).toMatchObject({
			title: "projectPromptSaveFailed",
			color: "red",
		});
	});

	test("an oversized file is read-only, so it can never be saved back", async () => {
		const loaded = promptQuery.data;
		expect(loaded).toBeDefined();
		promptQuery.data = { ...loaded, truncated: true } as typeof promptQuery.data;
		await renderDialog();
		expect(promptBox()?.readOnly).toBe(true);
	});
});
