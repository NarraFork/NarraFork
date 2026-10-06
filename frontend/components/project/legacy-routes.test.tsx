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
	useQuery: (options: { enabled?: boolean }) => {
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
	test("only pending requests render a loader", async () => {
		chapter = { isError: false, isLoading: true };
		await render();
		expect(container.querySelector("[data-loader]")).not.toBeNull();
		expect(navigate).not.toHaveBeenCalled();
	});
});
