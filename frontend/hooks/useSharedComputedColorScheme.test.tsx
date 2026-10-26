import { afterEach, beforeAll, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// Real DOM globals must not leak into (or inherit from) another test file's registry.
if (process.env.NF_SHARED_COLOR_SCHEME_CHILD !== "1") {
	it("runs the shared color scheme suite in an isolated process", async () => {
		const child = Bun.spawn([process.execPath, "test", "--isolate", import.meta.path], {
			env: { ...process.env, NF_SHARED_COLOR_SCHEME_CHILD: "1", NARRAFORK_HOME: undefined },
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
	let osDark = false;
	const changeListeners = new Set<(event: { matches: boolean }) => void>();
	let mantine: typeof import("@mantine/core");
	let useSharedComputedColorScheme: typeof import("./useSharedComputedColorScheme").useSharedComputedColorScheme;

	beforeAll(async () => {
		const { window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(window, {
			matchMedia: (query: string) => {
				return {
					get matches() {
						return query === "(prefers-color-scheme: dark)" ? osDark : false;
					},
					media: query,
					addEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
						changeListeners.add(listener),
					removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) =>
						changeListeners.delete(listener),
					addListener() {},
					removeListener() {},
				};
			},
			getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		});
		Object.assign(globalThis, {
			window,
			document: window.document,
			navigator: window.navigator,
			localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			getComputedStyle: window.getComputedStyle,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		mantine = await import("@mantine/core");
		({ useSharedComputedColorScheme } = await import("./useSharedComputedColorScheme"));
	});
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
		container?.remove();
	});

	function Probe({ id }: { id: number }) {
		const shared = useSharedComputedColorScheme("dark");
		const reference = mantine.useComputedColorScheme("dark");
		return <span data-probe={id} data-shared={shared} data-reference={reference} />;
	}

	function SharedProbe({ id }: { id: number }) {
		return <span data-probe={id} data-shared={useSharedComputedColorScheme("dark")} />;
	}

	async function render(
		providerProps: { forceColorScheme?: "light" | "dark"; defaultColorScheme?: "auto" },
		count = 1,
	) {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<mantine.MantineProvider {...providerProps}>
					{Array.from({ length: count }, (_, id) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed probe list
						<Probe key={id} id={id} />
					))}
				</mantine.MantineProvider>,
			);
		});
	}

	function probes() {
		return [...container.querySelectorAll("[data-probe]")].map((node) => ({
			shared: node.getAttribute("data-shared"),
			reference: node.getAttribute("data-reference"),
		}));
	}

	it("matches Mantine for a forced scheme", async () => {
		await render({ forceColorScheme: "light" });
		expect(probes()).toEqual([{ shared: "light", reference: "light" }]);
		await act(async () => root?.unmount());
		root = undefined;
		await render({ forceColorScheme: "dark" });
		expect(probes()).toEqual([{ shared: "dark", reference: "dark" }]);
	});

	it("follows the OS preference under auto, like Mantine", async () => {
		osDark = true;
		await render({ defaultColorScheme: "auto" }, 3);
		expect(probes()).toEqual(Array(3).fill({ shared: "dark", reference: "dark" }));
		await act(async () => root?.unmount());
		root = undefined;
		osDark = false;
		await render({ defaultColorScheme: "auto" }, 3);
		expect(probes()).toEqual(Array(3).fill({ shared: "light", reference: "light" }));
	});

	it("shares one OS listener across instances and re-renders on change", async () => {
		changeListeners.clear();
		osDark = false;
		await render({ defaultColorScheme: "auto" }, 0);
		await act(async () => {
			root?.render(
				<mantine.MantineProvider defaultColorScheme="auto">
					{Array.from({ length: 8 }, (_, id) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed probe list
						<SharedProbe key={id} id={id} />
					))}
				</mantine.MantineProvider>,
			);
		});
		const providerListeners = 1; // MantineProvider's own auto-scheme listener
		expect(changeListeners.size).toBe(providerListeners + 1);
		expect(probes().map((probe) => probe.shared)).toEqual(Array(8).fill("light"));

		osDark = true;
		await act(async () => {
			for (const listener of [...changeListeners]) listener({ matches: true } as never);
		});
		expect(probes().map((probe) => probe.shared)).toEqual(Array(8).fill("dark"));

		await act(async () => root?.unmount());
		root = undefined;
		expect(changeListeners.size).toBe(0);
	});
}
