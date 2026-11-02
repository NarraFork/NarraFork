/**
 * Create-session git identity: the pick is saved only when the display switch is on,
 * and only after the session exists. Loading and failure must not look like "none configured".
 */

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;

interface SelectOption {
	value?: string;
	label?: string;
}

const showNotification = mock(() => {});
const invalidateQueries = mock(() => Promise.resolve());
const setNarratorGitIdentity = mock((_id: string, _identityId: string) =>
	Promise.resolve({ ok: true }),
);
const create = mock((_data: unknown, options?: { onSuccess?: (result: unknown) => void }) => {
	options?.onSuccess?.({ id: "n-new", title: "New", cwd: "/tmp", status: "idle" });
});

let showInCreateModal = true;
const enabledSeen: boolean[] = [];
let identityQuery: {
	data?: Array<{ id: string; name: string; email: string; isDefault: boolean }>;
	isLoading: boolean;
	isError: boolean;
} = { data: [], isLoading: false, isError: false };

mock.module("@mantine/core", () => ({
	Alert: box,
	Badge: box,
	Divider: box,
	Group: box,
	Stack: box,
	Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
	TextInput: box,
	Textarea: box,
	// TextareaOptimizeControls renders a Menu; the mock must expose it or the module
	// fails to load before any assertion runs.
	Menu: Object.assign(box, {
		Target: box,
		Dropdown: box,
		Label: box,
		Item: box,
		Divider: box,
	}),
	NumberInput: box,
	Tooltip: box,
	ActionIcon: box,
	Checkbox: box,
	ScrollArea: box,
	Select: ({
		label,
		description,
		data,
		value,
		onChange,
		disabled,
	}: {
		label?: string;
		description?: string;
		data?: SelectOption[];
		value?: string | null;
		onChange?: (value: string | null) => void;
		disabled?: boolean;
	}) => (
		<div
			data-select={label}
			data-description={description}
			data-value={value ?? ""}
			data-disabled={disabled ? "true" : "false"}
		>
			{(data ?? []).map((item) =>
				item.value ? (
					<button
						key={item.value}
						type="button"
						disabled={disabled}
						onClick={() => onChange?.(item.value ?? null)}
					>
						{item.label}
					</button>
				) : null,
			)}
		</div>
	),
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
mock.module("@mantine/hooks", () => ({ useMediaQuery: () => false }));
mock.module("@mantine/notifications", () => ({
	notifications: { show: showNotification },
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@tanstack/react-query", () => ({
	useQuery: () => ({ data: { paths: { defaultProjectDir: "/instance" }, agent: {} } }),
	useQueryClient: () => ({ invalidateQueries }),
}));
mock.module("../../hooks/useModels", () => ({ useAllModels: () => ({ groupedModels: [] }) }));
mock.module("../../hooks/useProjectDirStatus", () => ({
	useProjectDirStatus: () => ({ usablePath: "/instance", needsChoice: false, isLoading: false }),
}));
mock.module("../../hooks/useNarrator", () => ({
	useCreateNarrator: () => ({ mutate: create, isPending: false }),
}));
// The dialog reads the prompt library for its "insert from library" picker. An empty
// library is enough here: this file is about git identity, and mocking the hook keeps
// the component's query/mutation wiring out of this test's surface.
mock.module("../../hooks/usePromptLibrary", () => ({
	usePromptLibrary: () => ({ data: [], isLoading: false }),
	useCreatePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
	useUpdatePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
	useDeletePrompt: () => ({ mutate: mock(() => {}), isPending: false }),
}));
const mutation = { mutate: mock(() => {}), reset: mock(() => {}), isPending: false };
mock.module("../../hooks/useFavoriteDirectories", () => ({
	useFavoriteDirectories: () => ({ data: [] }),
	useCreateFavoriteDirectory: () => mutation,
	useDeleteFavoriteDirectory: () => mutation,
	useReorderFavoriteDirectories: () => mutation,
}));
mock.module("../../hooks/useGitIdentityVisibility", () => ({
	useGitIdentityVisibility: () => ({
		contextMenu: false,
		createModal: showInCreateModal,
		setContextMenu: () => {},
		setCreateModal: () => {},
	}),
}));
mock.module("../../hooks/useGitIdentities", () => ({
	useGitIdentities: (enabled = true) => {
		enabledSeen.push(enabled);
		return identityQuery;
	},
	narratorGitIdentityQueryKey: (narratorId: string) => [
		"auth",
		"git-identities",
		"narrator",
		narratorId,
	],
}));
mock.module("../../lib/api", () => ({
	api: { getSettings: mock(() => {}), setNarratorGitIdentity },
}));
mock.module("../common/DirectoryPicker", () => ({ DirectoryPicker: box }));

const { CreateNarratorModal } = await import("./CreateNarratorModal");

const WORK_LABEL = "Work <a@b.co>";
let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	showInCreateModal = true;
	enabledSeen.length = 0;
	identityQuery = {
		data: [{ id: "id-work", name: "Work", email: "a@b.co", isDefault: true }],
		isLoading: false,
		isError: false,
	};
	create.mockClear();
	showNotification.mockClear();
	invalidateQueries.mockClear();
	setNarratorGitIdentity.mockReset();
	setNarratorGitIdentity.mockImplementation(() => Promise.resolve({ ok: true }));
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

async function clickText(text: string) {
	const button = Array.from(container.querySelectorAll("button")).find(
		(node) => node.textContent === text,
	);
	expect(button).toBeDefined();
	await act(async () => {
		button?.dispatchEvent(new window.Event("click", { bubbles: true }));
		await Promise.resolve();
		await Promise.resolve();
	});
}

function identitySelect() {
	return container.querySelector('[data-select="narrator:details.gitIdentity"]');
}

test("follow-default does not write a binding", async () => {
	await act(async () => root.render(<CreateNarratorModal opened onClose={() => {}} />));
	expect(identitySelect()?.getAttribute("data-description")).toBe(
		"narrator:details.gitIdentityCreateDescription",
	);
	expect(enabledSeen.at(-1)).toBe(true);
	await clickText("createNarrator");
	expect(setNarratorGitIdentity).not.toHaveBeenCalled();
});

test("an explicit identity is saved after create and refreshes the details query", async () => {
	await act(async () => root.render(<CreateNarratorModal opened onClose={() => {}} />));
	await clickText(WORK_LABEL);
	await clickText("createNarrator");
	expect(setNarratorGitIdentity).toHaveBeenCalledTimes(1);
	expect(setNarratorGitIdentity.mock.calls[0]).toEqual(["n-new", "id-work"]);
	expect(invalidateQueries).toHaveBeenCalledWith({
		queryKey: ["auth", "git-identities", "narrator", "n-new"],
	});
});

test("a hidden switch does not submit the selection still held in the dialog", async () => {
	function Host() {
		const [tick, setTick] = useState(0);
		return (
			<>
				<button type="button" onClick={() => setTick((n) => n + 1)}>
					refresh
				</button>
				<span data-tick={tick} />
				<CreateNarratorModal opened onClose={() => {}} />
			</>
		);
	}
	await act(async () => root.render(<Host />));
	await clickText(WORK_LABEL);
	showInCreateModal = false;
	await clickText("refresh");
	expect(identitySelect()).toBeNull();
	expect(enabledSeen.at(-1)).toBe(false);
	await clickText("createNarrator");
	expect(setNarratorGitIdentity).not.toHaveBeenCalled();
});

test("closing the dialog clears the pick so the next create follows the default", async () => {
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
	await act(async () => root.render(<Host />));
	await clickText(WORK_LABEL);
	await clickText("cancel");
	await clickText("reopen");
	expect(identitySelect()?.getAttribute("data-value")).toBe("__follow_default__");
	await clickText("createNarrator");
	expect(setNarratorGitIdentity).not.toHaveBeenCalled();
});

test("loading and failure are not shown as an empty identity list", async () => {
	identityQuery = { isLoading: true, isError: false };
	await act(async () => root.render(<CreateNarratorModal opened onClose={() => {}} />));
	expect(identitySelect()?.getAttribute("data-disabled")).toBe("true");
	expect(container.textContent).not.toContain("narrator:details.gitIdentityUnconfigured");
	expect(container.textContent).not.toContain("narrator:details.gitIdentityCreateLoadFailed");

	identityQuery = { isLoading: false, isError: true };
	function Host() {
		const [tick, setTick] = useState(0);
		return (
			<>
				<button type="button" onClick={() => setTick((n) => n + 1)}>
					refresh
				</button>
				<span data-tick={tick} />
				<CreateNarratorModal opened onClose={() => {}} />
			</>
		);
	}
	await act(async () => root.render(<Host />));
	await clickText("refresh");
	expect(container.textContent).toContain("narrator:details.gitIdentityCreateLoadFailed");
	expect(container.textContent).not.toContain("narrator:details.gitIdentityUnconfigured");

	identityQuery = { data: [], isLoading: false, isError: false };
	await clickText("refresh");
	expect(container.textContent).toContain("narrator:details.gitIdentityUnconfigured");
});

test("a failed bind reports the error and still leaves the created session", async () => {
	setNarratorGitIdentity.mockImplementation(() => Promise.reject(new Error("rejected")));
	const created: string[] = [];
	await act(async () =>
		root.render(
			<CreateNarratorModal
				opened
				onClose={() => {}}
				onCreated={(narrator) => created.push(narrator.id)}
			/>,
		),
	);
	await clickText(WORK_LABEL);
	await clickText("createNarrator");
	expect(created).toEqual(["n-new"]);
	expect(showNotification).toHaveBeenCalledWith(
		expect.objectContaining({ color: "red", message: "rejected" }),
	);
	expect(invalidateQueries).not.toHaveBeenCalled();
});
