import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../../lib/api";
import { ApiError } from "../../../lib/api/client";
import { WorkspaceTitleGenerator } from "./WorkspaceTitleGenerator";

type Candidate = Awaited<ReturnType<typeof api.generateWorkspaceTitle>>;
type Props = ComponentProps<typeof WorkspaceTitleGenerator>;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

let root: Root | undefined;
let container: HTMLDivElement;
let query: QueryClient;
let props: Props;
let generation: ReturnType<typeof deferred<Candidate>>;
let generateSpy: ReturnType<typeof spyOn<typeof api, "generateWorkspaceTitle">>;
let updateSpy: ReturnType<typeof spyOn<typeof api, "updateWorkspace">>;
let noticeSpy: ReturnType<typeof spyOn<typeof notifications, "show">>;
let restoreGlobals: () => void;
const translation = i18next.createInstance();
await translation.init({ lng: "en", resources: {}, react: { useSuspense: false } });

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const values = {
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		MouseEvent: window.MouseEvent ?? window.Event,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		matchMedia: (media: string) => ({
			media,
			matches: media.includes("prefers-reduced-motion"),
			addEventListener() {},
			removeEventListener() {},
		}),
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
		cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = new Map(
		Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	restoreGlobals = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	Object.assign(globalThis, values);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	query = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false, gcTime: 0 } },
	});
	props = { workspaceId: "workspace-1", titleSource: "default", titleRevision: 7, editing: false };
	generation = deferred<Candidate>();
	generateSpy = spyOn(api, "generateWorkspaceTitle").mockImplementation(() => generation.promise);
	updateSpy = spyOn(api, "updateWorkspace").mockResolvedValue({});
	noticeSpy = spyOn(notifications, "show").mockReturnValue("notice");
});

afterEach(async () => {
	await act(async () => {
		// Drain queued React Query observer notifications before restoring DOM globals.
		await new Promise((resolve) => setTimeout(resolve, 0));
		root?.unmount();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	root = undefined;
	query.clear();
	container.remove();
	generateSpy.mockRestore();
	updateSpy.mockRestore();
	noticeSpy.mockRestore();
	restoreGlobals();
});

async function render(next: Partial<Props> = {}) {
	props = { ...props, ...next };
	await act(async () => {
		root?.render(
			<MantineProvider
				env="test"
				theme={{
					respectReducedMotion: true,
					components: {
						Tooltip: { defaultProps: { transitionProps: { duration: 0 } } },
						Modal: { defaultProps: { transitionProps: { duration: 0 } } },
					},
				}}
			>
				<QueryClientProvider client={query}>
					<I18nextProvider i18n={translation}>
						<WorkspaceTitleGenerator {...props} />
					</I18nextProvider>
				</QueryClientProvider>
			</MantineProvider>,
		);
	});
}

function button(label: string) {
	const element = Array.from(document.querySelectorAll("button")).find(
		(node) => node.textContent === label || node.getAttribute("aria-label") === label,
	);
	if (!element) throw new Error(`Missing button: ${label}`);
	return element;
}

async function click(label = "workspaceGenerateTitle") {
	await act(async () => {
		button(label).dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

async function finish(value: Candidate = { title: "Generated title", expectedTitleRevision: 7 }) {
	await act(async () => {
		generation.resolve(value);
		await generation.promise;
	});
	// React Query notifies observers on its scheduled task, not the mutation promise.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("WorkspaceTitleGenerator", () => {
	test("default title adopts the generated candidate through a revision-guarded update", async () => {
		await render();
		await click();
		expect(generateSpy).toHaveBeenCalledWith("workspace-1");
		expect(updateSpy).not.toHaveBeenCalled();
		await finish();
		expect(updateSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy).toHaveBeenCalledWith("workspace-1", {
			title: "Generated title",
			expectedTitleRevision: 7,
		});
		expect(document.body.textContent).not.toContain("workspaceTitleReplaceHint");
	});

	test.each([
		"manual",
		"auto",
	] as const)("%s title requires explicit confirmation", async (source) => {
		await render({ titleSource: source });
		await click();
		await finish();
		expect(document.body.textContent).toContain("Generated title");
		expect(document.body.textContent).toContain("workspaceTitleReplaceHint");
		expect(updateSpy).not.toHaveBeenCalled();
		await click("workspaceTitleReplace");
		expect(updateSpy).toHaveBeenCalledWith("workspace-1", {
			title: "Generated title",
			expectedTitleRevision: 7,
		});
	});

	test("cancel dismisses the candidate without renaming", async () => {
		await render({ titleSource: "manual" });
		await click();
		await finish();
		await click("workspaceTitleKeep");
		expect(updateSpy).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain("Generated title");
	});

	test.each([
		["WORKSPACE_TITLE_NO_CONTENT", "workspaceTitleNoContent"],
		["WORKSPACE_TITLE_CONFLICT", "workspaceTitleChanged"],
	])("localizes the %s error without renaming", async (code, message) => {
		query.setQueryData(["workspace", "workspace-1"], { titleRevision: 7 });
		await render();
		await click();
		await act(async () => {
			generation.reject(new ApiError("English server message", 400, { code }));
		});
		expect(updateSpy).not.toHaveBeenCalled();
		expect(noticeSpy).toHaveBeenCalledWith(expect.objectContaining({ color: "red", message }));
		expect(query.getQueryState(["workspace", "workspace-1"])?.isInvalidated).toBe(true);
	});

	test("generation failure leaves the original title untouched and reports the error", async () => {
		await render();
		await click();
		await act(async () => {
			generation.reject(new Error("provider unavailable"));
		});
		expect(updateSpy).not.toHaveBeenCalled();
		expect(noticeSpy).toHaveBeenCalledWith(
			expect.objectContaining({ color: "red", message: "provider unavailable" }),
		);
	});

	test.each([
		"default",
		"manual",
	] as const)("entering then abandoning edit invalidates an in-flight %s generation", async (source) => {
		await render({ titleSource: source });
		await click();
		await render({ editing: true });
		await render({ editing: false });
		await finish();
		expect(updateSpy).not.toHaveBeenCalled();
		expect(document.body.textContent).not.toContain("Generated title");
	});

	test("a title revision change during generation rejects the response", async () => {
		await render();
		await click();
		await render({ titleRevision: 8 });
		await finish();
		expect(updateSpy).not.toHaveBeenCalled();
		expect(noticeSpy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "workspaceTitleChanged" }),
		);
	});

	test("a displayed candidate cannot overwrite a newer title revision", async () => {
		await render({ titleSource: "auto" });
		await click();
		await finish();
		await render({ titleRevision: 8 });
		expect(button("workspaceTitleReplace").disabled).toBe(true);
		expect(document.body.textContent).toContain("workspaceTitleChanged");
		await click("workspaceTitleReplace");
		expect(updateSpy).not.toHaveBeenCalled();
	});

	test("a rejected revision-guarded update reports failure without silently accepting the candidate", async () => {
		updateSpy.mockRejectedValue(new Error("title revision conflict"));
		await render({ titleSource: "manual" });
		await click();
		await finish();
		await click("workspaceTitleReplace");
		expect(updateSpy).toHaveBeenCalledTimes(1);
		expect(document.body.textContent).toContain("Generated title");
		expect(noticeSpy).toHaveBeenCalledWith(
			expect.objectContaining({ message: "title revision conflict" }),
		);
	});

	test("entering edit also dismisses an already displayed candidate", async () => {
		await render({ titleSource: "manual" });
		await click();
		await finish();
		await render({ editing: true });
		expect(document.body.textContent).not.toContain("Generated title");
		expect(button("workspaceGenerateTitle").disabled).toBe(true);
		expect(updateSpy).not.toHaveBeenCalled();
	});

	test("unmount invalidates the in-flight result and never submits a title", async () => {
		await render();
		await click();
		await act(async () => root?.unmount());
		root = undefined;
		await finish();
		expect(updateSpy).not.toHaveBeenCalled();
		expect(noticeSpy).not.toHaveBeenCalled();
	});

	test("rapid repeated clicks cannot start a second generation before loading renders", async () => {
		await render();
		await act(async () => {
			const trigger = button("workspaceGenerateTitle");
			trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const requestCount = generateSpy.mock.calls.length;
		await finish();
		expect(requestCount).toBe(1);
	});

	test("rapid repeated confirmations submit the candidate only once", async () => {
		const saving = deferred<Awaited<ReturnType<typeof api.updateWorkspace>>>();
		updateSpy.mockImplementation(() => saving.promise);
		await render({ titleSource: "manual" });
		await click();
		await finish();
		await act(async () => {
			const confirm = button("workspaceTitleReplace");
			confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		const requestCount = updateSpy.mock.calls.length;
		await act(async () => {
			saving.resolve({});
			await saving.promise;
		});
		expect(requestCount).toBe(1);
		expect(updateSpy).toHaveBeenCalledWith("workspace-1", {
			title: "Generated title",
			expectedTitleRevision: 7,
		});
	});

	test("loading disables repeated generation requests", async () => {
		await render();
		await click();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(button("workspaceGenerateTitle").disabled).toBe(true);
		await click();
		await click();
		expect(generateSpy).toHaveBeenCalledTimes(1);
		await finish();
	});
});
