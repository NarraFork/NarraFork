/**
 * Project prompt editing is a separate window from creating a session.
 *
 *  - creating a session never writes the prompt file, even when the editor is open
 *    and the text is dirty;
 *  - saving is its own action inside that window, and it uses the hash that was loaded;
 *  - a truncated file stays read-only, so the prefix cannot be written back.
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
		Alert: pass("alert"),
		Badge: pass("badge"),
		Box: pass("box"),
		Divider: pass("divider"),
		Group: pass("group"),
		Loader: pass("loader"),
		SegmentedControl: (props: {
			value?: string;
			onChange?: (value: string) => void;
			data?: Array<{ value: string; label: string }>;
		}) => (
			<div data-part="segmented" data-value={props.value}>
				{(props.data ?? []).map((item) => (
					<button key={item.value} type="button" onClick={() => props.onChange?.(item.value)}>
						{item.label}
					</button>
				))}
			</div>
		),
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
	useQueryClient: () => ({ invalidateQueries: mock(() => {}), setQueryData: mock(() => {}) }),
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
mock.module("./markdown/MarkdownContent", () => ({
	MarkdownContent: ({ text }: { text: string }) => <div data-part="markdown">{text}</div>,
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

async function clickButton(label: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(node) => node.textContent === label,
	);
	expect(button).toBeDefined();
	await act(async () => {
		button?.dispatchEvent(new window.Event("click", { bubbles: true }));
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("project prompt editor", () => {
	test("creating a session does not write the prompt file", async () => {
		await renderDialog();
		await clickButton("projectPromptOpen");
		await act(async () => {
			promptBox()?.onChange?.({ currentTarget: { value: "# 新内容\n" } });
		});
		await clickCreate();
		expect(saveProjectPrompt).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
	});

	test("the editor shows the loaded file and saves it on its own", async () => {
		await renderDialog();
		await clickButton("projectPromptOpen");
		expect(promptBox()?.value).toBe("# 旧内容\n");
		await act(async () => {
			promptBox()?.onChange?.({ currentTarget: { value: "# 新内容\n" } });
		});
		await clickButton("projectPromptSave");

		expect(saveProjectPrompt).toHaveBeenCalledTimes(1);
		const savedInput = (saveProjectPrompt.mock.calls as unknown[][])[0]?.[0];
		expect(savedInput).toMatchObject({
			cwd: "/ws",
			filename: "AGENTS.md",
			content: "# 新内容\n",
			baseHash: "hash-before",
		});
		expect(create).not.toHaveBeenCalled();
	});

	test("a refused save stays in the editor and does not create a session", async () => {
		saveProjectPrompt.mockImplementationOnce(async () => {
			throw new Error("The prompt file changed since it was opened");
		});
		await renderDialog();
		await clickButton("projectPromptOpen");
		await act(async () => {
			promptBox()?.onChange?.({ currentTarget: { value: "# 新内容\n" } });
		});
		await clickButton("projectPromptSave");

		expect(create).not.toHaveBeenCalled();
		expect(showNotification).toHaveBeenCalled();
		const shown = (showNotification.mock.calls as unknown[][])[0]?.[0];
		expect(shown).toMatchObject({
			title: "projectPromptSaveFailed",
			color: "red",
		});
	});

	test("an oversized file is read-only", async () => {
		const loaded = promptQuery.data;
		expect(loaded).toBeDefined();
		promptQuery.data = { ...loaded, truncated: true } as typeof promptQuery.data;
		await renderDialog();
		await clickButton("projectPromptOpen");
		expect(promptBox()?.readOnly).toBe(true);
	});

	test("preview hides the source box", async () => {
		await renderDialog();
		await clickButton("projectPromptOpen");
		expect(container.querySelector("[data-part='textarea']")).not.toBeNull();
		await clickButton("projectPromptModePreview");
		expect(container.querySelector("[data-part='textarea']")).toBeNull();
	});
});
