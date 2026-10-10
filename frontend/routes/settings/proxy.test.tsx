import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ProxyOverride } from "../../lib/proxy";
import locale from "../../locales/en/settings.json";

const notices: { message: string; color: string }[] = [];
const patches: Record<string, unknown>[] = [];
let failSave = false;
let settingsData = makeSettings();
function makeSettings() {
	return {
		proxy: { mode: "direct" },
		update: {
			source: "github",
			githubRepository: "fork/project",
			serverUrl: "https://private.example",
			channel: "beta",
			proxy: { mode: "custom", url: "http://old.example:8080" } as ProxyOverride,
		},
	};
}

// Exercise the route's actual query/mutation and PATCH wiring. The shared field's
// DOM gestures are independently covered in ProxyOverrideField.test.tsx.
mock.module("@mantine/core", () => {
	const Block = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
	return Object.fromEntries(
		[
			"Alert",
			"Badge",
			"Button",
			"Card",
			"Divider",
			"Group",
			"List",
			"Select",
			"Skeleton",
			"Stack",
			"Text",
			"TextInput",
			"Title",
		].map((name) => [name, name === "List" ? Object.assign(Block, { Item: Block }) : Block]),
	);
});
mock.module("@mantine/notifications", () => ({
	notifications: { show: (notice: { message: string; color: string }) => notices.push(notice) },
}));
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: unknown) => ({ options }),
}));
mock.module("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, vars?: { error?: string }) =>
			String(locale[key as keyof typeof locale] ?? key).replace("{{error}}", vars?.error ?? ""),
	}),
}));
mock.module("../../hooks/useAuth", () => ({ useCurrentUser: () => ({ data: { role: "admin" } }) }));
mock.module("../../lib/api", () => ({
	api: {
		getSettings: async () => structuredClone(settingsData),
		getUserPreferences: async () => ({}),
		updateSettings: async (patch: Record<string, unknown>) => {
			patches.push(JSON.parse(JSON.stringify(patch)));
			if (failSave) throw new Error("mock save rejected");
			const update = patch.update as { proxy: ProxyOverride };
			settingsData = { ...settingsData, update: { ...settingsData.update, proxy: update.proxy } };
			return structuredClone(settingsData);
		},
	},
}));
mock.module("../../lib/api/misc", () => ({ miscApi: { listAllHooks: async () => [] } }));
mock.module("../../components/common/ProxyOverrideField", () => ({
	ProxyOverrideField: ({
		value,
		onChange,
		disabled,
	}: {
		value?: ProxyOverride;
		onChange: (next?: ProxyOverride) => void;
		disabled?: boolean;
	}) => (
		<div data-proxy-mode={value?.mode ?? "default"}>
			<button type="button" disabled={disabled} onClick={() => onChange(undefined)}>
				inherit
			</button>
			<button
				type="button"
				disabled={disabled}
				onClick={() => onChange({ mode: "custom", url: "https://new.example:8443" })}
			>
				custom
			</button>
		</div>
	),
}));
const { Route } = await import("./proxy");
const Page = Route.options.component as () => ReactNode;
let root: Root;
let container: HTMLElement;
let client: QueryClient;
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
	settingsData = makeSettings();
	failSave = false;
	patches.length = 0;
	notices.length = 0;
	client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	client.setQueryData(["admin", "settings"], structuredClone(settingsData));
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

async function renderPage() {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Page />
			</QueryClientProvider>,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}
async function clickUpdate(action: string) {
	// The update group is the last non-empty override group in these fixtures.
	const buttons = Array.from(container.querySelectorAll("button")).filter(
		(button) => button.textContent === action,
	);
	const target = buttons.at(-1);
	if (!target) throw new Error("Update override action not rendered");
	await act(async () => {
		target.dispatchEvent(new Event("click", { bubbles: true }));
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
}

describe("update proxy management wiring", () => {
	test("renders the shared update override and persists explicit inheritance only", async () => {
		const original = structuredClone(settingsData);
		await renderPage();
		expect(container.textContent).toContain(locale.proxyGroupUpdates);
		expect(container.textContent).toContain(locale.proxyUpdatesDesc);
		await clickUpdate("inherit");
		expect(patches).toEqual([{ update: { proxy: { mode: "default" } } }]);
		expect(settingsData.update).toEqual({ ...original.update, proxy: { mode: "default" } });
		expect(settingsData.proxy).toEqual(original.proxy);
		expect(client.getQueryData<typeof settingsData>(["admin", "settings"])).toEqual(settingsData);
	});

	test("custom proxy updates the same single field", async () => {
		await renderPage();
		await clickUpdate("custom");
		expect(patches).toEqual([
			{ update: { proxy: { mode: "custom", url: "https://new.example:8443" } } },
		]);
	});

	test("save errors preserve the persisted override and display failure", async () => {
		failSave = true;
		const original = structuredClone(settingsData);
		await renderPage();
		await clickUpdate("inherit");
		expect(settingsData).toEqual(original);
		expect(notices).toContainEqual({
			message: "Failed to save proxy: mock save rejected",
			color: "red",
		});
	});
});
