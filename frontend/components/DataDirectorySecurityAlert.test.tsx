import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { DataDirectorySecurityStatus } from "@shared/data-directory-security";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { api, clearToken, setToken } from "../lib/api";
import { ConfirmDialogContext } from "./common/confirm-dialog-context";

const realI18n = { ...(await import("react-i18next")) };
mock.module("react-i18next", () => ({
	...realI18n,
	useTranslation: () => ({ t: (key: string) => key }),
}));
const { DataDirectorySecurityAlert, DataDirectorySecurityCheckButton } = await import(
	"./DataDirectorySecurityAlert"
);
const restricted: DataDirectorySecurityStatus = {
	status: "restricted",
	canRepair: true,
	details: { code: "unsafe_mode", path: "/private/app", mode: "755", message: "unsafe" },
};
let root: Root;
let container: HTMLElement;
let client: QueryClient;
const confirm = mock(async () => true);
let get: ReturnType<typeof spyOn<typeof api, "getDataDirectorySecurity">>;
let repair: ReturnType<typeof spyOn<typeof api, "repairDataDirectorySecurity">>;
let toast: ReturnType<typeof spyOn<typeof notifications, "show">>;
const globals = [
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"localStorage",
	"window",
	"Event",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"IS_REACT_ACT_ENVIRONMENT",
	"getComputedStyle",
	"matchMedia",
];
const saved = new Map(
	globals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const storage = new Map<string, string>();
	Object.assign(globalThis, {
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		window,
		Event: window.Event,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		IS_REACT_ACT_ENVIRONMENT: true,
		getComputedStyle: () =>
			new Proxy({}, { get: (_, key) => (key === "getPropertyValue" ? () => "" : "") }),
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
	setToken("test-session");
	get = spyOn(api, "getDataDirectorySecurity").mockResolvedValue(restricted);
	repair = spyOn(api, "repairDataDirectorySecurity").mockResolvedValue({
		status: "ok",
		canRepair: false,
	});
	toast = spyOn(notifications, "show").mockImplementation(() => "test-toast");
	confirm.mockClear();
	confirm.mockImplementation(async () => true);
});

afterEach(() => {
	act(() => root.unmount());
	client.clear();
	clearToken();
	get.mockRestore();
	repair.mockRestore();
	toast.mockRestore();
	for (const key of globals) {
		const descriptor = saved.get(key);
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
afterAll(() => mock.module("react-i18next", () => realI18n));

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 15));
	});
}
async function render(role: "admin" | "user" = "admin", loggedIn = true, entry = false) {
	if (loggedIn) client.setQueryData(["auth", "me"], { id: role, role });
	else clearToken();
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<MantineProvider env="test">
					<ConfirmDialogContext.Provider value={{ confirm }}>
						<DataDirectorySecurityAlert />
						{entry && <DataDirectorySecurityCheckButton />}
					</ConfirmDialogContext.Provider>
				</MantineProvider>
			</QueryClientProvider>,
		),
	);
	await settle();
}
async function openModal() {
	const message = toast.mock.calls[0]?.[0].message as { props: { children: unknown[] } };
	const action = message.props.children.at(-1) as { props: { onClick: () => void } };
	await act(async () => action.props.onClick());
	await settle();
}
function button(key: string) {
	return [...document.querySelectorAll("button")].find((node) =>
		node.textContent?.includes(`dataDirectorySecurity.${key}`),
	);
}
async function click(key: string) {
	const node = button(key);
	expect(node).toBeDefined();
	await act(async () => node?.click());
	await settle();
}

test("notification has no layout placeholder and is deduplicated after refetch and remount", async () => {
	await render();
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(container.textContent).not.toContain("dataDirectorySecurity");
	expect(toast).toHaveBeenCalledTimes(1);
	expect(toast.mock.calls[0]?.[0].id).toBe("data-directory-security");
	const notice = renderToStaticMarkup(
		<MantineProvider env="test">{toast.mock.calls[0]?.[0].message}</MantineProvider>,
	);
	expect(notice).not.toContain("/private/app");
	expect(notice).not.toContain("unsafe_mode");
	notifications.hide("data-directory-security");
	await act(async () => {
		await client.refetchQueries({ queryKey: ["data-directory-security"] });
	});
	await settle();
	await act(async () => root.render(null));
	await render();
	expect(toast).toHaveBeenCalledTimes(1);
});

test("JWT renewal does not re-show a dismissed notice", async () => {
	await render();
	expect(toast).toHaveBeenCalledTimes(1);
	notifications.hide("data-directory-security");
	setToken("renewed-session-token");
	await act(async () => {
		await client.refetchQueries({ queryKey: ["data-directory-security"] });
	});
	await render();
	expect(toast).toHaveBeenCalledTimes(1);
});

test("storage check entry reopens the same flow and refreshes without another notification", async () => {
	await render("admin", true, true);
	await click("check");
	expect(get).toHaveBeenCalledTimes(2);
	expect(document.querySelector('[role="dialog"]') !== null).toBe(true);
	expect(toast).toHaveBeenCalledTimes(1);
	expect(repair).not.toHaveBeenCalled();
});

test("healthy status is invisible", async () => {
	get.mockResolvedValue({ status: "ok", canRepair: false });
	await render();
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(get).toHaveBeenCalledTimes(1);
	expect(toast).not.toHaveBeenCalled();
	expect(container.textContent).not.toContain("dataDirectorySecurity");
});
test("logged out does not probe or display cached details", async () => {
	await render("admin", false);
	expect(get).not.toHaveBeenCalled();
	expect(container.querySelector('[role="alert"]')).toBeNull();
});
test("ordinary users see contact advice but no path or repair", async () => {
	await render("user");
	await openModal();
	expect(document.body.textContent).toContain("contactAdmin");
	expect(document.body.textContent).not.toContain("/private/app");
	expect(button("repair")).toBeUndefined();
});
test("admin details are collapsed and unrepairable state requires manual handling", async () => {
	get.mockResolvedValue({ ...restricted, canRepair: false });
	await render();
	await openModal();
	expect(document.querySelector("details")?.hasAttribute("open")).toBe(false);
	expect(document.body.textContent).toContain("/private/app");
	expect(document.body.textContent).toContain("755");
	expect(document.body.textContent).toContain("manual");
	expect(button("repair")).toBeUndefined();
});
test("pending confirmation sends no POST and cancellation leaves the modal usable", async () => {
	let decide!: (value: boolean) => void;
	confirm.mockImplementation(
		() =>
			new Promise<boolean>((resolve) => {
				decide = resolve;
			}),
	);
	await render();
	await openModal();
	await click("repair");
	expect(repair).not.toHaveBeenCalled();
	expect(button("repair")?.disabled).toBe(true);
	await act(async () => decide(false));
	await settle();
	expect(repair).not.toHaveBeenCalled();
	expect(button("repair")?.disabled).toBe(false);
});

test("cancel sends no repair request", async () => {
	confirm.mockResolvedValue(false);
	await render();
	await openModal();
	await click("repair");
	expect(confirm).toHaveBeenCalledTimes(1);
	expect(repair).not.toHaveBeenCalled();
});
test("confirmed repair runs once, disables repeats and closes modal with retry toast", async () => {
	let finish!: (result: DataDirectorySecurityStatus) => void;
	repair.mockImplementation(
		() =>
			new Promise((resolve) => {
				finish = resolve;
			}),
	);
	await render();
	await openModal();
	await click("repair");
	expect(button("repair")?.disabled).toBe(true);
	expect(button("recheck")?.disabled).toBe(true);
	await click("repair");
	expect(repair).toHaveBeenCalledTimes(1);
	await act(async () => finish({ status: "ok", canRepair: false }));
	await settle();
	expect(container.querySelector('[role="alert"]')).toBeNull();
	expect(toast).toHaveBeenCalledWith({ color: "green", message: "dataDirectorySecurity.success" });
});
test.each([
	"restricted",
	"unavailable",
] as const)("repair returning %s keeps warning", async (status) => {
	repair.mockResolvedValue({ status, canRepair: false });
	await render();
	await openModal();
	await click("repair");
	expect(document.body.textContent).toContain("repairFailed");
	expect(document.body.textContent).toContain("manual");
	expect(toast).toHaveBeenCalledTimes(1);
});
test("HTTP repair failure remains visible without disclosing raw errors", async () => {
	repair.mockRejectedValue(new Error("/secret/error"));
	await render();
	await openModal();
	await click("repair");
	expect(document.body.textContent).toContain("repairFailed");
	expect(document.body.textContent).not.toContain("/secret/error");
	repair.mockResolvedValue({ status: "ok", canRepair: false });
	await click("repair");
	expect(repair).toHaveBeenCalledTimes(2);
	expect(document.querySelector('[role="dialog"]') === null).toBe(true);
});
test("query failure warns and manual recheck recovers", async () => {
	get.mockRejectedValue(new Error("offline"));
	await render();
	await openModal();
	expect(document.body.textContent).toContain("queryFailed");
	get.mockResolvedValue({ status: "ok", canRepair: false });
	await click("recheck");
	expect(document.body.textContent).toContain("healthy");
});
