import { afterEach, beforeAll, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createVListInteractionAdmission } from "../vlist-interaction-admission";
import { VListInteractionAdmissionContext } from "../vlist-interaction-admission-context";

// Mantine + DOM globals must not inherit another test file's React module registry.
if (process.env.NF_TIMING_ADMISSION_CHILD !== "1") {
	it("runs timing admission's real DOM suite in an isolated process", async () => {
		const child = Bun.spawn([process.execPath, "test", "--isolate", import.meta.path], {
			env: { ...process.env, NF_TIMING_ADMISSION_CHILD: "1", NARRAFORK_HOME: undefined },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, output: code ? (stdout + stderr).slice(-16000) : "" }).toEqual({
			code: 0,
			output: "",
		});
	}, 30000);
} else {
	let root: Root | undefined;
	let container: HTMLElement;
	let frames = new Map<number, FrameRequestCallback>();
	let serial = 0;
	const renderedIds = new Set<string>();
	let ToolTimingArea: typeof import("./RenderToolCall").ToolTimingArea;
	let MantineProvider: typeof import("@mantine/core").MantineProvider;
	const timing = {
		startedAt: null,
		streamStartedAt: 1700000000000,
		permissionStartedAt: null,
		executionStartedAt: 1700000000500,
		completedAt: 1700000002500,
		createdAt: null,
		durationMs: 2000,
	} satisfies import("../measure/measure-tool-call").ToolTimingStamps;
	beforeAll(async () => {
		const { window } = parseHTML("<html><head></head><body></body></html>");
		const media = () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
		});
		Object.assign(window, {
			matchMedia: media,
			getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		});
		Object.assign(globalThis, {
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			getComputedStyle: window.getComputedStyle,
			requestAnimationFrame: (callback: FrameRequestCallback) => {
				const id = ++serial;
				frames.set(id, callback);
				return id;
			},
			cancelAnimationFrame: (id: number) => frames.delete(id),
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		({ MantineProvider } = await import("@mantine/core"));
		({ ToolTimingArea } = await import("./RenderToolCall"));
	});
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
		container?.remove();
		frames = new Map();
	});
	function coldStore() {
		const store = createVListInteractionAdmission();
		store.observeScroll({ scrollTop: 100, viewportHeight: 400, atBottom: false });
		store.suspend();
		return store;
	}
	async function mount(store: ReturnType<typeof coldStore> | null, count = 6, running = false) {
		if (!root) {
			container = document.createElement("div");
			document.body.append(container);
			root = createRoot(container);
		}
		await act(async () => {
			root?.render(
				<MantineProvider forceColorScheme="dark">
					<VListInteractionAdmissionContext.Provider value={store}>
						{Array.from({ length: count }, (_, id) => ({ id })).map(({ id }) => (
							<section key={id}>
								<span>synthetic body {id}</span>
								<Profiler id={String(id)} onRender={(id) => renderedIds.add(id)}>
									<ToolTimingArea running={running} durationMs={2000} timing={timing} />
								</Profiler>
							</section>
						))}
					</VListInteractionAdmissionContext.Provider>
				</MantineProvider>,
			);
		});
	}
	async function frame() {
		const batch = [...frames];
		frames.clear();
		await act(async () => {
			for (const [, callback] of batch) callback(performance.now());
		});
	}
	function getButton() {
		const button = container.querySelector("button");
		if (!button) throw new Error("Expected a real timing trigger button");
		return button;
	}
	async function click(button: Element) {
		await act(async () => {
			button.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
	}
	it("cold historical timing keeps real buttons/ARIA/body and no portal DOM", async () => {
		const store = coldStore();
		await mount(store);
		expect(store.getDebugSnapshot()).toMatchObject({ active: 6, pending: 6 });
		expect(container.querySelectorAll("button").length).toBe(6);
		for (const button of container.querySelectorAll("button")) {
			expect(button.getAttribute("type")).toBe("button");
			expect(button.getAttribute("aria-label")).toContain("2023");
			expect(button.getAttribute("aria-expanded")).toBe("false");
			expect(button.textContent).toContain("2");
		}
		expect(document.querySelectorAll("[data-portal]").length).toBe(0);
		expect(container.textContent).toContain("synthetic body 5");
	});
	it("direct first click admits exactly one component and preserves its button identity", async () => {
		const store = coldStore();
		await mount(store);
		const button = getButton();
		await click(button);
		expect(container.querySelector("button")).toBe(button);
		expect(store.getDebugSnapshot()).toMatchObject({ pending: 5, active: 6 });
		expect(document.querySelectorAll("[data-portal]").length).toBe(1);
		expect(button.getAttribute("aria-expanded")).toBe("false");
		await frame();
		expect(button.getAttribute("aria-expanded")).toBe("true");
	});
	it("Escape during priming cancels the first open request", async () => {
		const store = coldStore();
		await mount(store, 1);
		const button = getButton();
		await click(button);
		await act(async () => {
			const event = new window.Event("keydown", { bubbles: true });
			Object.assign(event, { key: "Escape" });
			document.dispatchEvent(event);
		});
		await frame();
		expect(button.getAttribute("aria-expanded")).toBe("false");
	});
	it("outside mousedown during priming cancels and unmount cancels the priming RAF", async () => {
		await mount(coldStore(), 1);
		const button = getButton();
		await click(button);
		await act(async () => {
			document.body.dispatchEvent(new window.Event("mousedown", { bubbles: true }));
		});
		await frame();
		expect(button.getAttribute("aria-expanded")).toBe("false");
		await act(async () => root?.unmount());
		root = undefined;
		await mount(coldStore(), 1);
		await click(getButton());
		expect(frames.size).toBeGreaterThan(0);
		await act(async () => root?.unmount());
		root = undefined;
		expect(frames.size).toBe(0);
	});
	it("idle admits only two timing subtrees per frame with identical body/button DOM", async () => {
		const store = coldStore();
		await mount(store);
		const before = container.innerHTML;
		const buttons = [...container.querySelectorAll("button")];
		renderedIds.clear();
		await act(async () => {
			store.resume();
			await new Promise((resolve) => setTimeout(resolve, 140));
		});
		await frame();
		// Mantine defaults to one reused shared portal target, not one DOM node per Portal.
		expect(document.querySelectorAll("[data-portal]").length).toBe(1);
		expect([...renderedIds].sort()).toEqual(["0", "1"]);
		expect(container.innerHTML).toBe(before);
		expect([...container.querySelectorAll("button")]).toEqual(buttons);
		expect(store.getDebugSnapshot().pending).toBe(4);
		await frame();
		expect(store.getDebugSnapshot().pending).toBe(2);
		store.suspend();
	});
	it("bottom transition eagerly admits all pending timing components", async () => {
		const store = coldStore();
		await mount(store);
		await act(async () => store.resume(true));
		expect(store.getDebugSnapshot().pending).toBe(0);
		expect(document.querySelectorAll("[data-portal]").length).toBe(1);
		store.suspend();
	});
	it("no provider and running timing retain eager portal mount", async () => {
		await mount(null, 1);
		expect(document.querySelectorAll("[data-portal]").length).toBe(1);
		await mount(coldStore(), 1, true);
		expect(document.querySelectorAll("[data-portal]").length).toBe(1);
	});
}
