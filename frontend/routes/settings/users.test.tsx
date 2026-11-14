import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import locale from "../../locales/en/common.json";

const deletes: Array<{ id: string; options: { transferScheduledTasks: boolean } }> = [];
const cursors: Array<string | null> = [];
let failPreview = false;
let noTasks = false;
let failDelete = false;

// Preserve actual React Query/mutation and confirmation state; only replace visual primitives.
mock.module("@mantine/core", () => {
	const Block = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
	const Button = ({
		children,
		onClick,
		disabled,
		loading,
		"aria-label": label,
	}: {
		children?: ReactNode;
		onClick?: () => void;
		disabled?: boolean;
		loading?: boolean;
		"aria-label"?: string;
	}) => (
		<button type="button" aria-label={label} disabled={disabled || loading} onClick={onClick}>
			{children}
		</button>
	);
	return {
		ActionIcon: Button,
		Button,
		Badge: Block,
		Group: Block,
		Loader: Block,
		Paper: Block,
		Stack: Block,
		Switch: Block,
		Text: Block,
		TextInput: Block,
		Title: Block,
		Tooltip: Block,
		Table: Object.assign(Block, { Thead: Block, Tr: Block, Th: Block, Tbody: Block, Td: Block }),
		Modal: ({
			opened,
			title,
			children,
		}: {
			opened: boolean;
			title: string;
			children?: ReactNode;
		}) => (opened ? <section aria-label={title}>{children}</section> : null),
		Checkbox: ({
			checked,
			onChange,
			label,
		}: {
			checked: boolean;
			onChange: (event: { currentTarget: { checked: boolean } }) => void;
			label: string;
		}) => (
			<button
				type="button"
				aria-pressed={checked}
				onClick={() => onChange({ currentTarget: { checked: !checked } })}
			>
				{label}
			</button>
		),
	};
});
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: unknown) => ({ options }),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, vars?: { username?: string }) =>
			String(locale[key as keyof typeof locale] ?? key).replace(
				"{{username}}",
				vars?.username ?? "",
			),
	}),
}));
mock.module("../../hooks/useAuth", () => ({
	useCurrentUser: () => ({ data: { id: "admin", role: "admin" } }),
}));
mock.module("../../components/common/confirm-dialog-context", () => ({
	useConfirmDialog: () => async () => true,
}));
mock.module("../../components/knowledge/UserAclModal", () => ({ UserAclModal: () => null }));
mock.module("../../components/settings/CreateUserModal", () => ({ CreateUserModal: () => null }));
mock.module("../../components/settings/RegistrationCodesSection", () => ({
	RegistrationCodesSection: () => null,
}));
mock.module("../../lib/api", () => ({
	api: {
		listUsers: async () => [
			{ id: "target", username: "Target", role: "user", createdAt: "2026-01-01T00:00:00.000Z" },
		],
		getSettings: async () => ({ auth: { registrationOpen: false } }),
		previewUserScheduledTaskTransfer: async (_id: string, cursor: string | null) => {
			cursors.push(cursor);
			if (failPreview) throw new Error("preview unavailable");
			if (noTasks) return { items: [], nextCursor: null };
			return {
				items: [
					{
						id: cursor ? "two" : "one",
						name: cursor ? "Second affected task" : "First affected task",
						enabled: true,
						completedAt: null,
					},
				],
				nextCursor: cursor ? null : "one",
			};
		},
		deleteUser: async (id: string, options: { transferScheduledTasks: boolean }) => {
			deletes.push({ id, options });
			if (failDelete) throw new Error("Deletion rejected");
			return { ok: true };
		},
		updateUser: async () => ({}),
		updateAdminSettings: async () => ({}),
	},
}));
const { Route } = await import("./users");
const Page = Route.options.component as () => ReactNode;
let root: Root, container: HTMLElement, client: QueryClient;
const globals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	deletes.length = 0;
	cursors.length = 0;
	failPreview = false;
	noTasks = false;
	failDelete = false;
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});
async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}
async function openDeletion() {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Page />
			</QueryClientProvider>,
		);
	});
	await flush();
	const open = container.querySelector<HTMLButtonElement>('button[aria-label="Delete"]');
	if (!open) throw new Error("Delete action missing");
	await act(async () => {
		open.click();
	});
	await flush();
}
function button(text: string) {
	const result = [...container.querySelectorAll<HTMLButtonElement>("section button")].find(
		(item) => item.textContent === text,
	);
	if (!result) throw new Error(`Button missing: ${text}`);
	return result;
}
async function click(text: string) {
	await act(async () => {
		button(text).click();
	});
	await flush();
}

describe("delete-user task takeover confirmation", () => {
	test("shows affected tasks with pagination and requires explicit takeover", async () => {
		await openDeletion();
		expect(container.textContent).toContain("First affected task");
		expect(button(locale.delete).disabled).toBe(true);
		await click(locale.deleteUserScheduledTasksMore);
		expect(container.textContent).toContain("Second affected task");
		expect(cursors).toEqual([null, "one"]);
		await click(locale.deleteUserScheduledTasksConfirm);
		expect(button(locale.delete).disabled).toBe(false);
		await click(locale.delete);
		expect(deletes).toEqual([{ id: "target", options: { transferScheduledTasks: true } }]);
		expect(container.querySelector("section")).toBeNull();
	});

	test("preview failure blocks deletion and offers a retry", async () => {
		failPreview = true;
		await openDeletion();
		expect(container.textContent).toContain(locale.deleteUserScheduledTasksLoadFailed);
		expect(button(locale.delete).disabled).toBe(true);
		expect(deletes).toEqual([]);
		failPreview = false;
		await click(locale.retry);
		expect(container.textContent).toContain("First affected task");
		expect(button(locale.delete).disabled).toBe(true);
	});

	test("an empty preview does not silently opt in to future task transfers", async () => {
		noTasks = true;
		await openDeletion();
		expect(button(locale.delete).disabled).toBe(false);
		await click(locale.delete);
		expect(deletes).toEqual([{ id: "target", options: { transferScheduledTasks: false } }]);
	});

	test("failed deletion keeps the dialog open, reloads tasks and requires fresh confirmation", async () => {
		failDelete = true;
		await openDeletion();
		await click(locale.deleteUserScheduledTasksConfirm);
		await click(locale.delete);
		expect(container.textContent).toContain("Deletion rejected");
		expect(button(locale.delete).disabled).toBe(true);
		expect(cursors.length).toBeGreaterThan(1);
		expect(button(locale.deleteUserScheduledTasksConfirm).getAttribute("aria-pressed")).toBe(
			"false",
		);
	});
});
