import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import type {
	BuiltinPluginSummary,
	PluginSource,
	PluginSourceView,
	PluginUpdateJob,
	PluginUpdateView,
} from "@shared/plugin-source";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";
import type { PluginDetail } from "../../lib/api/plugins";
import en from "../../locales/en/plugins.json";
import zh from "../../locales/zh-CN/plugins.json";

const ID = "io.narrafork.provider-quota";
const globals = new Map<string, PropertyDescriptor | undefined>();
const inputPrototype = parseHTML("<html></html>").window.HTMLInputElement.prototype;
const originalChecked = Object.getOwnPropertyDescriptor(inputPrototype, "checked");
if (!originalChecked)
	Object.defineProperty(inputPrototype, "checked", {
		configurable: true,
		get(this: HTMLInputElement) {
			return this.hasAttribute("checked");
		},
		set(this: HTMLInputElement, value: boolean) {
			if (value) this.setAttribute("checked", "");
			else this.removeAttribute("checked");
		},
	});
function installDom() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
	Object.defineProperty(window.document, "oninput", { configurable: true, value: null });
	Object.defineProperty(window.document, "fonts", {
		configurable: true,
		value: { addEventListener() {}, removeEventListener() {} },
	});
	const matchMedia = (query: string) => ({
		matches: query === "(prefers-reduced-motion: reduce)",
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	Object.assign(window, { matchMedia });
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		HTMLSelectElement: window.HTMLSelectElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		matchMedia,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		localStorage: { getItem: () => null },
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		if (!globals.has(key)) globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}
installDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MantineProvider } = await import("@mantine/core");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { I18nextProvider } = await import("react-i18next");
const realRouter = await import("@tanstack/react-router");
const navigations: unknown[] = [];
mock.module("@tanstack/react-router", () => ({
	...realRouter,
	createFileRoute: () => (options: object) => ({ ...options, useParams: () => ({ pluginId: ID }) }),
	useNavigate: () => async (target: unknown) => {
		navigations.push(target);
	},
	Link: ({ children, to, ...props }: { children?: React.ReactNode; to?: string }) => (
		<a href={to} {...props}>
			{children}
		</a>
	),
}));
const realConfirm = await import("../common/confirm-dialog-context");
mock.module("../common/confirm-dialog-context", () => ({
	...realConfirm,
	useConfirmDialog: () => async () => true,
}));
const { SettingsPluginsPage } = await import("../../routes/settings/plugins.index");
const { SettingsPluginDetailPage } = await import("../../routes/settings/plugins.$pluginId");
const { pluginKeys } = await import("../../hooks/usePlugins");

const i18n = createInstance();
await i18n.init({
	lng: "en",
	defaultNS: "plugins",
	resources: { en: { plugins: en }, "zh-CN": { plugins: zh } },
	interpolation: { escapeValue: false },
});
let root: Root;
let host: HTMLElement;
let client: InstanceType<typeof QueryClient>;
let installed: boolean;
let plugin: PluginDetail;
let source: PluginSourceView;
let updates: PluginUpdateView;
let builtin: BuiltinPluginSummary;
let job: PluginUpdateJob | null;
let counter: number;
let saveError: boolean;
let preferenceError: boolean;
let missingJobStatus: number;
const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
const originalFetch = globalThis.fetch;
const github: PluginSource = {
	type: "github",
	owner: "example",
	repo: "plugin",
	assetName: "plugin-{version}.nfplugin",
};
function makeJob(kind: PluginUpdateJob["kind"]): PluginUpdateJob {
	counter++;
	return {
		id: `job-${counter}`,
		pluginId: ID,
		kind,
		status: "running",
		phase: kind === "check" ? "checking" : "downloading",
		cancellable: true,
		downloadedBytes: 0,
		totalBytes: kind === "check" ? null : 100,
		error: null,
		createdAt: "2026-11-13T00:00:00Z",
		updatedAt: `2026-11-13T00:00:0${counter}Z`,
	};
}
function reply(body: unknown, status = 200) {
	return Response.json(body, { status });
}
async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const path = new URL(String(input), "http://localhost").pathname;
	const method = init?.method ?? "GET";
	const body =
		typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
	requests.push({ path, method, body });
	if (path === "/api/plugins" && method === "GET")
		return reply({ plugins: installed ? [plugin] : [] });
	if (path === "/api/plugins/builtins") return reply({ builtins: [builtin] });
	if (path === `/api/plugins/${ID}` && method === "GET") return reply(plugin);
	if (path === `/api/plugins/${ID}/source` && method === "GET") return reply(source);
	if (path === `/api/plugins/${ID}/source` && method === "PUT") {
		if (saveError || body.expectedRevision !== source.binding.revision)
			return reply({ message: "private source failure", code: "source_changed" }, 409);
		source = {
			...source,
			origin: body.source ? "configured" : "none",
			binding: {
				revision: source.binding.revision + 1,
				mode: body.source ? "configured" : "none",
				source: body.source as PluginSource | null,
				autoUpdate: false,
			},
		};
		updates = {
			...updates,
			status: body.source ? "idle" : "no_source",
			latest: null,
			candidateId: undefined,
			jobId: undefined,
			error: null,
		};
		return reply(source);
	}
	if (path === `/api/plugins/${ID}/updates` && method === "GET") return reply(updates);
	if (path === `/api/plugins/${ID}/updates/preferences`) {
		if (preferenceError || body.expectedRevision !== source.binding.revision)
			return reply({ message: "private preference failure", code: "source_changed" }, 409);
		source = {
			...source,
			binding: {
				...source.binding,
				revision: source.binding.revision + 1,
				autoUpdate: body.autoUpdate === true,
			},
		};
		return reply(source);
	}
	if (path === `/api/plugins/${ID}/updates/check`) {
		job = makeJob("check");
		updates = { ...updates, status: "checking", jobId: job.id };
		return reply({ jobId: job.id }, 202);
	}
	if (path === `/api/plugins/${ID}/updates/apply`) {
		if (
			body.candidateId !== updates.candidateId ||
			body.expectedRevision !== source.binding.revision
		)
			return reply({ message: "candidate conflict", code: "source_changed" }, 409);
		job = makeJob("update");
		updates = { ...updates, jobId: job.id };
		return reply({ jobId: job.id }, 202);
	}
	if (path === `/api/plugins/builtins/${ID}/install`) {
		job = makeJob("install_builtin");
		return reply({ jobId: job.id }, 202);
	}
	if (path.startsWith("/api/plugins/update-jobs/")) {
		if (!job) return reply({ code: "NOT_FOUND", message: "missing job" }, missingJobStatus);
		if (path.endsWith("/cancel") && method === "POST")
			job = {
				...job,
				status: "cancelled",
				phase: "completed",
				error: "cancelled",
				cancellable: false,
			};
		return reply(job);
	}
	if (path === `/api/plugins/${ID}/uninstall`) {
		installed = false;
		builtin = { ...builtin, installed: false, installedVersion: null };
		return reply(plugin);
	}
	if (path === `/api/plugins/${ID}/retry`) return reply(plugin);
	if (path.startsWith("/api/plugins/")) return reply({});
	throw new Error(`Unexpected test API request: ${method} ${path}`);
}

beforeEach(async () => {
	installDom();
	await i18n.changeLanguage("en");
	client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	client.setQueryData(["auth", "me"], { role: "admin" });
	plugin = {
		pluginId: ID,
		displayName: "Legacy plugin",
		version: "1.0.0",
		desiredState: "enabled",
		runtimeState: "active",
		packageKind: "installed",
		canUninstall: true,
		current: { version: "1.0.0", hash: "old-hash" },
	};
	source = {
		pluginId: ID,
		binding: { revision: 0, mode: "inherit", source: null, autoUpdate: false },
		declaredSource: null,
		origin: "none",
		diagnostics: [],
	};
	updates = {
		pluginId: ID,
		status: "no_source",
		installedVersion: "1.0.0",
		checkedAt: null,
		latest: null,
		error: null,
	};
	builtin = {
		pluginId: ID,
		displayName: "Provider quota",
		version: "1.0.3",
		source: { type: "local", builtinId: ID },
		installed: true,
		installedVersion: "1.0.0",
		canInstall: true,
	};
	installed = true;
	job = null;
	counter = 0;
	saveError = false;
	preferenceError = false;
	missingJobStatus = 404;
	requests.length = 0;
	navigations.length = 0;
	globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect });
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});
afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	host.remove();
	globalThis.fetch = originalFetch;
});
afterAll(() => {
	mock.restore();
	if (originalChecked) Object.defineProperty(inputPrototype, "checked", originalChecked);
	else Reflect.deleteProperty(inputPrototype, "checked");
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});
async function settle() {
	await act(async () => {
		for (let index = 0; index < 3; index++) await new Promise((resolve) => setTimeout(resolve, 0));
	});
}
async function mount(page: "index" | "detail" = "detail") {
	await act(async () =>
		root.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider
						env="test"
						withCssVariables={false}
						withGlobalClasses={false}
						theme={{
							respectReducedMotion: true,
							components: { Tooltip: { defaultProps: { transitionProps: { duration: 0 } } } },
						}}
					>
						{page === "index" ? <SettingsPluginsPage /> : <SettingsPluginDetailPage />}
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		),
	);
	await settle();
}
function button(key: string) {
	const found = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
		(element) => element.textContent?.trim() === i18n.t(key),
	);
	if (!found) throw new Error(`Button missing: ${key}`);
	return found;
}
async function click(key: string) {
	await act(async () => button(key).dispatchEvent(new window.Event("click", { bubbles: true })));
	await settle();
}
function field(key: string): HTMLInputElement | HTMLSelectElement {
	const label = Array.from(host.querySelectorAll("label")).find((element) =>
		element.textContent?.startsWith(i18n.t(key)),
	);
	const id = label?.getAttribute("for");
	const found = id ? host.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`) : null;
	if (!found) throw new Error(`Field missing: ${key}`);
	return found;
}
async function fill(key: string, value: string) {
	const element = field(key);
	if (element.tagName === "INPUT" && !element.getAttribute("type"))
		element.setAttribute("type", "text");
	const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value");
	await act(async () => {
		if (element.tagName === "SELECT") {
			// linkedom exposes select.value as read-only; option selection is the native state.
			for (const option of element.querySelectorAll("option")) {
				if (option.getAttribute("value") === value) option.setAttribute("selected", "");
				else option.removeAttribute("selected");
			}
		} else if (descriptor?.set) descriptor.set.call(element, value);
		else element.value = value;
		element.dispatchEvent(
			new window.Event(element.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
		);
	});
	await settle();
}
async function toggle(key: string, value: boolean) {
	const element = field(key) as HTMLInputElement;
	const descriptor = Object.getOwnPropertyDescriptor(inputPrototype, "checked");
	await act(async () => {
		if (descriptor?.set) descriptor.set.call(element, value);
		else element.checked = value;
		element.dispatchEvent(new window.Event("click", { bubbles: true }));
	});
	await settle();
}
async function showSource() {
	await click("admin.detail.tabs.sourceUpdates");
}
function configured(value: PluginSource = github) {
	source = {
		...source,
		origin: "configured",
		binding: { ...source.binding, mode: "configured", source: value },
	};
	updates = { ...updates, status: "idle" };
}
function available(manual = false) {
	updates = {
		...updates,
		status: manual ? "manual_required" : "available",
		candidateId: "candidate-1",
		latest: { version: "1.1.0", size: 100, sha256: "a".repeat(64), notes: "Release notes" },
		checkedAt: "2026-11-13T00:00:00Z",
		error: manual ? "manual_required" : null,
	};
}
async function advance(patch: Partial<PluginUpdateJob>) {
	if (!job) throw new Error("No active job");
	job = { ...job, ...patch };
	if (job.status === "succeeded" && job.kind === "check") available();
	if (job.status === "succeeded" && job.kind !== "check") {
		const version = job.kind === "install_builtin" ? builtin.version : "1.1.0";
		plugin = {
			...plugin,
			version,
			current: { version, hash: "new-hash" },
			origin: "builtin",
			packageKind: "installed",
			canUninstall: true,
		};
		installed = true;
		builtin = { ...builtin, installed: true, installedVersion: version };
		updates = {
			...updates,
			status: "up_to_date",
			installedVersion: version,
			candidateId: undefined,
		};
	}
	if (job.status === "failed") updates = { ...updates, status: "error", error: job.error };
	await act(async () => {
		await client.invalidateQueries({ queryKey: pluginKeys.updateJob(job?.id ?? "") });
		await client.invalidateQueries({ queryKey: pluginKeys.updates(ID) });
	});
	await settle();
}

test.each([
	"en",
	"zh-CN",
])("old plugin without source keeps runtime retry, plain name and disabled auto updates (%s)", async (locale) => {
	await i18n.changeLanguage(locale);
	source.diagnostics = [{ code: "SOURCE_INVALID", message: "bad optional file" }];
	await mount();
	await showSource();
	expect(host.querySelector("h3")?.querySelector("a")).toBeNull();
	expect((field("admin.updates.automatic") as HTMLInputElement).checked).toBe(false);
	expect((field("admin.updates.automatic") as HTMLInputElement).disabled).toBe(true);
	expect(button("admin.updates.check").disabled).toBe(true);
	expect(host.textContent).toContain(i18n.t("admin.runtime.active"));
	expect(host.textContent).toContain(i18n.t("admin.sources.diagnostics.SOURCE_INVALID"));
	await click("admin.actions.retry");
	expect(
		requests.some((request) => request.path.endsWith("/retry") && request.method === "POST"),
	).toBe(true);
	expect(requests.some((request) => request.path.endsWith("/updates/check"))).toBe(false);
});

test.each([
	["github", "en"],
	["website", "en"],
	["local", "en"],
	["github", "zh-CN"],
	["website", "zh-CN"],
	["local", "zh-CN"],
] as const)("select and save %s source, with only explicit homepage links (%s)", async (type, locale) => {
	await i18n.changeLanguage(locale);
	await mount();
	await showSource();
	await fill("admin.sources.type", type);
	if (type === "github") {
		await fill("admin.sources.owner", "example");
		await fill("admin.sources.repo", "plugin");
		await fill("admin.sources.assetName", "plugin-{version}.nfplugin");
		await fill("admin.sources.homepage", "https://github.com/example/plugin");
	} else if (type === "website") {
		await fill("admin.sources.updateApi", "https://updates.example/latest");
		await fill("admin.sources.homepage", "https://custom.example/plugin");
	}
	await click("admin.sources.save");
	const saved = requests.find(
		(request) => request.path.endsWith("/source") && request.method === "PUT",
	);
	expect(saved?.body.expectedRevision).toBe(0);
	expect((saved?.body.source as PluginSource)?.type).toBe(type);
	const anchor = host.querySelector("h3 a");
	if (type === "local") expect(anchor).toBeNull();
	else {
		expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(anchor?.getAttribute("target")).toBe("_blank");
	}
});

test.each([
	"en",
	"zh-CN",
])("clearing a source removes homepage and auto controls without repo/publisher fallback (%s)", async (locale) => {
	await i18n.changeLanguage(locale);
	configured({ ...github, homepage: "https://explicit.example/plugin" });
	source.declaredSource = { ...github, homepage: "https://package.example/plugin" };
	await mount();
	await showSource();
	expect(host.querySelector("h3 a")?.getAttribute("href")).toBe("https://explicit.example/plugin");
	await click("admin.sources.clear");
	expect(host.querySelector("h3 a")).toBeNull();
	expect(source.binding.source).toBeNull();
	expect(source.binding.autoUpdate).toBe(false);
	expect(button("admin.updates.check").disabled).toBe(true);
});

test("unsafe homepage is rejected before save and never linked", async () => {
	configured();
	await mount();
	await showSource();
	await fill("admin.sources.homepage", "javascript:alert(1)");
	await click("admin.sources.save");
	expect(host.querySelector("h3 a")).toBeNull();
	expect(host.textContent).toContain(i18n.t("admin.sources.invalidSource"));
	expect(
		requests.filter((request) => request.method === "PUT" && request.path.endsWith("/source")),
	).toHaveLength(0);
});

test.each([
	"en",
	"zh-CN",
])("auto toggles send revisions and a failed preference preserves the previous value (%s)", async (locale) => {
	await i18n.changeLanguage(locale);
	configured();
	await mount();
	await showSource();
	await toggle("admin.updates.automatic", true);
	expect(source.binding.autoUpdate).toBe(true);
	expect((field("admin.updates.automatic") as HTMLInputElement).checked).toBe(true);
	await toggle("admin.updates.automatic", false);
	expect(source.binding.autoUpdate).toBe(false);
	preferenceError = true;
	await toggle("admin.updates.automatic", true);
	expect(source.binding.autoUpdate).toBe(false);
	expect((field("admin.updates.automatic") as HTMLInputElement).checked).toBe(false);
	expect(host.textContent).toContain(i18n.t("admin.updates.errors.source_changed"));
	expect(
		requests
			.filter((request) => request.path.endsWith("/preferences"))
			.map((request) => request.body.expectedRevision),
	).toEqual([0, 1, 2]);
});

test.each([
	["succeeded", "en"],
	["failed", "en"],
	["succeeded", "zh-CN"],
	["failed", "zh-CN"],
] as const)("check and apply progress reports %s without inventing installed state (%s)", async (outcome, locale) => {
	await i18n.changeLanguage(locale);
	configured();
	await mount();
	await showSource();
	await click("admin.updates.check");
	expect(host.querySelector("[data-job-phase='checking']")).not.toBeNull();
	await advance({ status: "succeeded", phase: "completed", cancellable: false });
	expect(button("admin.updates.apply").disabled).toBe(false);
	await click("admin.updates.apply");
	const applied = requests.find((request) => request.path.endsWith("/updates/apply"));
	expect(applied?.body).toEqual({ candidateId: "candidate-1", expectedRevision: 0 });
	await advance({
		downloadedBytes: 40,
		totalBytes: 100,
		phase: "downloading",
		status: "running",
		cancellable: true,
	});
	expect(host.textContent).toContain(
		i18n.t("admin.updates.byteProgress", { bytes: 40, total: 100 }),
	);
	expect(plugin.version).toBe("1.0.0");
	await advance({
		status: outcome,
		phase: "completed",
		cancellable: false,
		error: outcome === "failed" ? "hash_mismatch" : null,
	});
	const version = outcome === "failed" ? "1.0.0" : "1.1.0";
	expect(plugin.version).toBe(version);
	expect(host.textContent).toContain(i18n.t("admin.updates.installedVersion", { version }));
	if (outcome === "failed")
		expect(host.textContent).toContain(i18n.t("admin.updates.errors.hash_mismatch"));
});

test("cancel is allowed before commit but disabled during irreversible apply", async () => {
	configured();
	available();
	await mount();
	await showSource();
	await click("admin.updates.apply");
	await advance({ phase: "applying", cancellable: false, downloadedBytes: 100 });
	expect(button("admin.updates.cancel").disabled).toBe(true);
	await advance({ phase: "downloading", cancellable: true });
	await click("admin.updates.cancel");
	expect(job?.status).toBe("cancelled");
	expect(plugin.version).toBe("1.0.0");
});

test("manual trust change is explicit, per candidate, and never opens automatic grants", async () => {
	configured();
	available(true);
	await mount();
	await showSource();
	expect(button("admin.updates.apply").disabled).toBe(true);
	await toggle("admin.updates.allowTrustChange", true);
	await click("admin.updates.apply");
	expect(
		requests.find((request) => request.path.endsWith("/updates/apply"))?.body.allowTrustChange,
	).toBe(true);
	expect(source.binding.autoUpdate).toBe(false);
});

test("failed source save retains the old homepage, runtime and edited draft", async () => {
	configured({ ...github, homepage: "https://old.example/plugin" });
	await mount();
	await showSource();
	await fill("admin.sources.homepage", "https://new.example/plugin");
	saveError = true;
	await click("admin.sources.save");
	expect(host.querySelector("h3 a")?.getAttribute("href")).toBe("https://old.example/plugin");
	expect(field("admin.sources.homepage").value).toBe("https://new.example/plugin");
	expect(plugin.version).toBe("1.0.0");
});

test.each([
	"en",
	"zh-CN",
])("archive builtin can uninstall and explicitly reinstall from the plugin page (%s)", async (locale) => {
	await i18n.changeLanguage(locale);
	plugin = {
		...plugin,
		builtin: true,
		origin: "builtin",
		packageKind: "installed",
		canUninstall: true,
	};
	await mount("index");
	const uninstall = host.querySelector<HTMLButtonElement>(
		`button[aria-label='${i18n.t("admin.actions.uninstall")}']`,
	);
	expect(uninstall).not.toBeNull();
	await act(async () => uninstall?.dispatchEvent(new window.Event("click", { bubbles: true })));
	await settle();
	expect(installed).toBe(false);
	expect(
		requests.some(
			(request) => request.path.endsWith("/install") && request.path.includes("/builtins/"),
		),
	).toBe(false);
	await click("admin.builtins.installEnable");
	expect(job?.kind).toBe("install_builtin");
	await advance({ status: "succeeded", phase: "completed", cancellable: false });
	expect(builtin.installed).toBe(true);
	expect(plugin.version).toBe("1.0.3");
	expect(host.textContent).toContain(i18n.t("admin.builtins.reinstall"));
});

test("homepage click opens only the explicit source link and does not activate the row", async () => {
	configured({ ...github, homepage: "https://explicit.example/plugin" });
	await mount("index");
	const link = host.querySelector<HTMLAnchorElement>("a[target='_blank']");
	expect(link?.getAttribute("href")).toBe("https://explicit.example/plugin");
	await act(async () => link?.dispatchEvent(new window.Event("click", { bubbles: true })));
	expect(navigations).toEqual([]);
	const row = host.querySelector("tbody tr");
	await act(async () => row?.dispatchEvent(new window.Event("click", { bubbles: true })));
	expect(navigations).toHaveLength(1);
});

test.each([
	"en",
	"zh-CN",
])("builtin install failure does not claim installation or trigger an automatic retry (%s)", async (locale) => {
	await i18n.changeLanguage(locale);
	installed = false;
	builtin = { ...builtin, installed: false, installedVersion: null };
	await mount("index");
	await click("admin.builtins.installEnable");
	await advance({
		status: "failed",
		phase: "completed",
		error: "apply_failed",
		cancellable: false,
	});
	expect(installed).toBe(false);
	expect(builtin.installed).toBe(false);
	expect(host.textContent).toContain(i18n.t("admin.builtins.notInstalled"));
	expect(host.textContent).toContain(i18n.t("admin.updates.errors.apply_failed"));
	expect(
		requests.filter(
			(request) => request.path.includes("/builtins/") && request.path.endsWith("/install"),
		),
	).toHaveLength(1);
});

test("ordinary users keep old plugin operations but cannot read or mutate administrator sources", async () => {
	client.setQueryData(["auth", "me"], { role: "user" });
	await mount();
	await showSource();
	expect(button("admin.updates.check").disabled).toBe(true);
	expect(button("admin.sources.save").disabled).toBe(true);
	expect(host.textContent).toContain(i18n.t("admin.sources.adminOnly"));
	expect(
		requests.some(
			(request) => request.path.endsWith("/source") || request.path.endsWith("/updates"),
		),
	).toBe(false);
	expect(button("admin.actions.retry").disabled).toBe(false);
});

test("insecure HTTP sources stay manual-only with automatic updates disabled", async () => {
	configured({
		type: "website",
		updateApi: "http://updates.example/latest",
		downloadOrigins: [],
		allowInsecureHttp: true,
	});
	await mount();
	await showSource();
	expect((field("admin.updates.automatic") as HTMLInputElement).disabled).toBe(true);
	expect(host.textContent).toContain(i18n.t("admin.updates.insecureManualOnly"));
	expect(button("admin.updates.check").disabled).toBe(false);
});

test("trust confirmation cannot carry over to another candidate or source revision", async () => {
	configured();
	available(true);
	await mount();
	await showSource();
	await toggle("admin.updates.allowTrustChange", true);
	expect(button("admin.updates.apply").disabled).toBe(false);
	updates = { ...updates, candidateId: "different-candidate" };
	await act(async () => {
		await client.invalidateQueries({ queryKey: pluginKeys.updates(ID) });
	});
	await settle();
	expect((field("admin.updates.allowTrustChange") as HTMLInputElement).checked).toBe(false);
	expect(button("admin.updates.apply").disabled).toBe(true);
});

test("legacy readonly directory builtin has no uninstall action", async () => {
	plugin = {
		...plugin,
		builtin: true,
		origin: "builtin",
		packageKind: "builtin-directory",
		canUninstall: false,
	};
	await mount("index");
	expect(
		host.querySelector(`button[aria-label='${i18n.t("admin.actions.uninstall")}']`),
	).toBeNull();
});

test.each([
	404, 503,
])("a missing job status %s unlocks only definitively retired work", async (status) => {
	configured();
	available();
	updates.jobId = "retired-job";
	missingJobStatus = status;
	await mount();
	await showSource();
	await settle();
	expect(button("admin.updates.check").disabled).toBe(status !== 404);
	expect(button("admin.updates.apply").disabled).toBe(status !== 404);
	expect(field("admin.updates.automatic").disabled).toBe(status !== 404);
	if (status === 404) {
		await click("admin.updates.check");
		expect(job?.kind).toBe("check");
	}
});

test("a locally started job retired after completion cannot leave stale running data locked", async () => {
	configured();
	await mount();
	await showSource();
	await click("admin.updates.check");
	const oldId = job?.id;
	if (!oldId) throw new Error("Expected check job");
	const readJob = (): PluginUpdateJob | null => job;
	job = null;
	updates = { ...updates, status: "idle", jobId: undefined };
	await act(async () => {
		await client.invalidateQueries({ queryKey: pluginKeys.updateJob(oldId) });
	});
	await settle();
	expect(button("admin.updates.check").disabled).toBe(false);
	await click("admin.updates.check");
	expect(readJob()?.id).not.toBe(oldId);
});

test("a retired builtin install job allows another explicit install attempt", async () => {
	installed = false;
	builtin = { ...builtin, installed: false, installedVersion: null };
	await mount("index");
	await click("admin.builtins.installEnable");
	const oldId = job?.id;
	if (!oldId) throw new Error("Expected builtin job");
	job = null;
	await act(async () => {
		await client.invalidateQueries({ queryKey: pluginKeys.updateJob(oldId) });
	});
	await settle();
	expect(button("admin.builtins.installEnable").disabled).toBe(false);
});
