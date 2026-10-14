import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ComponentType, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

let chapter: {
	data?: { projectId: string; status: string };
	isLoading: boolean;
	isError: boolean;
	error?: unknown;
};
let sessions: {
	data?: { id: string; variant: string }[];
	isLoading: boolean;
	isError: boolean;
	error?: unknown;
};
let mapping: {
	data?: { narratorId: string | null; projectId: string };
	isLoading: boolean;
	isError: boolean;
	error?: unknown;
};
let mappingEnabled: boolean | undefined;
const navigate = mock(async (_target: unknown) => {});
const create = mock(async () => {});
const remove = mock(async () => {});
let listEnabled: boolean | undefined;
const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
mock.module("@mantine/core", () => ({
	Alert: box,
	Button: ({
		children,
		onClick,
		to,
	}: {
		children?: ReactNode;
		onClick?: () => void;
		to?: string;
	}) =>
		to ? (
			<a href={to}>{children}</a>
		) : (
			<button type="button" onClick={onClick}>
				{children}
			</button>
		),
	Modal: ({ opened, children }: { opened: boolean; children?: ReactNode }) =>
		opened ? <div data-modal="true">{children}</div> : null,
	Group: box,
	Text: box,
	Center: box,
	Stack: box,
	Loader: () => <div data-loader="true" />,
}));
mock.module("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module("@tanstack/react-query", () => ({
	useQuery: (options: { enabled?: boolean; queryKey: unknown[] }) => {
		if (options.queryKey[0] === "legacy-chapter-target") {
			mappingEnabled = options.enabled;
			return mapping;
		}
		listEnabled = options.enabled;
		return sessions;
	},
}));
mock.module("@tanstack/react-router", () => ({
	createFileRoute: () => (options: { component: ComponentType }) => ({
		options,
		useParams: () => ({ chapterId: "old-chapter" }),
	}),
	useLocation: () => ({ hash: "msg-existing" }),
	useSearch: () => ({ from: "search" }),
	useNavigate: () => navigate,
	Link: box,
}));
mock.module("../../hooks/useChapters", () => ({ useChapter: () => chapter }));
mock.module("../../lib/api", () => ({
	api: { listNarrators: mock(async () => []), createNarrator: create, deleteChapter: remove },
}));
mock.module("./LegacyResourceRecovery", () => ({
	LegacyResourceRecovery: ({ chapterId }: { chapterId: string }) => (
		<div data-recovery={chapterId}>recovery</div>
	),
}));
mock.module("./ProjectCompatibilityPanel", () => ({
	ProjectCompatibilityPanel: ({ projectId }: { projectId: string }) => (
		<div data-configuration-source={projectId}>original configuration</div>
	),
}));
mock.module("./LegacyMigrationAssistant", () => ({
	LegacyMigrationAssistant: ({
		projectId,
		autoOpen,
	}: {
		projectId: string;
		autoOpen?: boolean;
	}) => (
		<div data-migration-project={projectId} data-migration-auto={autoOpen}>
			migration.entry
		</div>
	),
}));
const { NarratorCompatibilityEntry } = await import("./NarratorCompatibilityEntry");
const { Route } = await import("../../routes/chapters/$chapterId");
const Page = Route.options.component as ComponentType;
let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	chapter = {
		data: { projectId: "old-project", status: "dormant" },
		isLoading: false,
		isError: false,
	};
	sessions = { data: [], isLoading: false, isError: false };
	mapping = { isLoading: false, isError: true, error: { status: 404 } };
	mappingEnabled = undefined;
	navigate.mockClear();
	create.mockClear();
	remove.mockClear();
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
	expect(create).not.toHaveBeenCalled();
	expect(remove).not.toHaveBeenCalled();
});

async function render() {
	await act(async () => root.render(<Page />));
}

describe("legacy route terminal states", () => {
	test("ordinary narrator details reach defaults, skills, devices and knowledge without a project", async () => {
		await act(async () => root.render(<NarratorCompatibilityEntry />));
		expect(container.querySelector("[data-modal]")).toBeNull();
		await act(async () =>
			container
				.querySelector("button")
				?.dispatchEvent(new window.Event("click", { bubbles: true })),
		);
		expect(container.textContent).toContain("compatibility.noProject");
		for (const path of [
			"/settings/agent",
			"/settings/chapters",
			"/settings/devices",
			"/routines",
			"/knowledge",
		])
			expect(container.querySelector(`a[href="${path}"]`)).not.toBeNull();
		expect(container.querySelector("[data-configuration-source]")).toBeNull();
	});
	test("explicit narrator project context opens the original compatibility source", async () => {
		await act(async () => root.render(<NarratorCompatibilityEntry projectId="original-source" />));
		await act(async () =>
			container
				.querySelector("button")
				?.dispatchEvent(new window.Event("click", { bubbles: true })),
		);
		expect(container.querySelector('[data-configuration-source="original-source"]')).not.toBeNull();
	});
	test("empty primary session lists terminate loading and retain direct recovery", async () => {
		await render();
		expect(container.textContent).toContain("legacyRoute.empty");
		expect(
			container
				.querySelector('[data-migration-project="old-project"]')
				?.getAttribute("data-migration-auto"),
		).toBe("true");
		expect(container.querySelector("[data-loader]")).toBeNull();
		expect(container.querySelector('[data-recovery="old-chapter"]')).not.toBeNull();
		expect(navigate).not.toHaveBeenCalled();
	});
	test.each([
		401, 403, 404, 500,
	])("error %i terminates and does not redirect stale cached sessions", async (status) => {
		chapter.isError = true;
		chapter.error = { status };
		sessions.data = [{ id: "stale-session", variant: "primary" }];
		await render();
		expect(container.querySelector("[data-loader]")).toBeNull();
		expect(container.querySelector("[data-recovery]")).toBeNull();
		expect(container.textContent).toContain(
			`legacyRoute.${status === 401 || status === 403 ? "denied" : status === 404 ? "missing" : "error"}`,
		);
		expect(listEnabled).toBe(false);
		expect(mappingEnabled).toBe(status === 404);
		expect(navigate).not.toHaveBeenCalled();
	});
	test("session query failure has a terminal state instead of a perpetual loader", async () => {
		sessions = { isError: true, isLoading: false, error: new Error("offline") };
		await render();
		expect(container.textContent).toContain("legacyRoute.error");
		expect(container.querySelector("[data-loader]")).toBeNull();
	});
	test("primary session redirects once with message hash and origin preserved", async () => {
		sessions.data = [
			{ id: "sub", variant: "subagent:general" },
			{ id: "primary", variant: "primary" },
		];
		await render();
		expect(navigate).toHaveBeenCalledTimes(1);
		expect(navigate.mock.calls[0]?.[0]).toEqual({
			to: "/narrators/$narratorId",
			params: { narratorId: "primary" },
			search: { from: "search" },
			hash: "msg-existing",
			replace: true,
		});
	});
	test("deleted chapter uses authorized mapping and preserves the original origin and hash", async () => {
		chapter = { isError: true, isLoading: false, error: { status: 404 } };
		mapping = {
			isError: false,
			isLoading: false,
			data: { narratorId: "retained", projectId: "deleted-project" },
		};
		await render();
		expect(mappingEnabled).toBe(true);
		expect(navigate.mock.calls[0]?.[0]).toEqual({
			to: "/narrators/$narratorId",
			params: { narratorId: "retained" },
			search: { from: "search" },
			hash: "msg-existing",
			replace: true,
		});
	});
	test.each([
		401, 403,
	])("denied chapter %i never uses a cached migration target", async (status) => {
		chapter = { isError: true, isLoading: false, error: { status } };
		mapping = { isError: false, isLoading: false, data: { narratorId: "cached", projectId: "p" } };
		await render();
		expect(mappingEnabled).toBe(false);
		expect(navigate).not.toHaveBeenCalled();
		expect(container.textContent).toContain("legacyRoute.denied");
	});
	test("migrated empty chapter shows completion and sessions link without querying removed project", async () => {
		chapter = { isError: true, isLoading: false, error: { status: 404 } };
		mapping = {
			isError: false,
			isLoading: false,
			data: { narratorId: null, projectId: "deleted-project" },
		};
		await render();
		expect(container.textContent).toContain("legacyRoute.migratedEmpty");
		expect(container.querySelector('a[href="/narrators"]')).not.toBeNull();
		expect(container.querySelector("[data-migration-project]")).toBeNull();
		expect(container.querySelector("[data-configuration-source]")).toBeNull();
		expect(navigate).not.toHaveBeenCalled();
	});
	test("mapping lookup denial is terminal and cannot use stale cached target", async () => {
		chapter = { isError: true, isLoading: false, error: { status: 404 } };
		mapping = {
			isError: true,
			isLoading: false,
			error: { status: 403 },
			data: { narratorId: "cached", projectId: "p" },
		};
		await render();
		expect(container.textContent).toContain("legacyRoute.denied");
		expect(navigate).not.toHaveBeenCalled();
		expect(container.querySelector("[data-loader]")).toBeNull();
	});
	test("pending mapping lookup has a bounded-query loading state", async () => {
		chapter = { isError: true, isLoading: false, error: { status: 404 } };
		mapping = { isError: false, isLoading: true };
		await render();
		expect(container.querySelector("[data-loader]")).not.toBeNull();
		expect(navigate).not.toHaveBeenCalled();
	});
	test("only pending requests render a loader", async () => {
		chapter = { isError: false, isLoading: true };
		await render();
		expect(container.querySelector("[data-loader]")).not.toBeNull();
		expect(navigate).not.toHaveBeenCalled();
	});
});
