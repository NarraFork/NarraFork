import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { parseHTML } from "linkedom";
import { act, createContext, memo, useContext, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useMobileViewport } from "./useMobileViewport";

const originals = new Map<string, PropertyDescriptor | undefined>();
let root: Root;
let container: HTMLElement;

function installWindow(initialMobile = false, legacy = false, withMatchMedia = true) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	let mobile = initialMobile;
	const listeners = new Set<() => void>();
	const counts = { queries: 0, adds: 0, removes: 0 };
	const add = (listener: () => void) => {
		counts.adds++;
		listeners.add(listener);
	};
	const remove = (listener: () => void) => {
		counts.removes++;
		listeners.delete(listener);
	};
	const query = {
		get matches() {
			return mobile;
		},
		media: MOBILE_VIEWPORT_MEDIA_QUERY,
		...(legacy
			? { addListener: add, removeListener: remove }
			: {
					addEventListener(name: string, listener: () => void) {
						expect(name).toBe("change");
						add(listener);
					},
					removeEventListener(name: string, listener: () => void) {
						expect(name).toBe("change");
						remove(listener);
					},
				}),
	};
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: withMatchMedia
			? (requested: string) => {
					counts.queries++;
					expect(requested).toBe(MOBILE_VIEWPORT_MEDIA_QUERY);
					return query;
				}
			: undefined,
	});
	for (const key of ["innerWidth", "innerHeight", "outerWidth", "outerHeight"]) {
		Object.defineProperty(window, key, {
			configurable: true,
			get() {
				throw new Error(`Forbidden viewport geometry read: ${key}`);
			},
		});
	}
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	return {
		counts,
		listeners,
		setMatches(value: boolean) {
			mobile = value;
		},
		emit(value: boolean) {
			mobile = value;
			for (const listener of [...listeners]) listener();
		},
	};
}

let media: ReturnType<typeof installWindow>;
beforeEach(() => {
	media = installWindow();
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	expect(media.listeners.size).toBe(0);
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

function Consumer({ values }: { values: boolean[] }) {
	const mobile = useMobileViewport();
	values.push(mobile);
	return <output>{String(mobile)}</output>;
}

describe("shared mobile viewport", () => {
	test("initial mobile snapshot is true without an initial false render or geometry reads", async () => {
		media.setMatches(true);
		const values: boolean[] = [];
		await act(async () => root.render(<Consumer values={values} />));
		expect(values).toEqual([true]);
		expect(media.counts).toEqual({ queries: 1, adds: 1, removes: 0 });
	});

	test("two consumers share one native listener and each render once per change", async () => {
		const first: boolean[] = [];
		const second: boolean[] = [];
		const tree = (
			<>
				<Consumer values={first} />
				<Consumer values={second} />
			</>
		);
		await act(async () => root.render(tree));
		for (const mobile of [true, false]) await act(async () => media.emit(mobile));
		expect(first).toEqual([false, true, false]);
		expect(second).toEqual(first);
		await act(async () => media.emit(false));
		expect(first).toEqual([false, true, false]);
		expect(media.counts).toEqual({ queries: 1, adds: 1, removes: 0 });
		expect(media.listeners.size).toBe(1);
	});

	test("route/context and memoized child see the same live snapshot in one native change", async () => {
		const RouteSafeArea = createContext(false);
		const parentValues: boolean[] = [];
		const childValues: Array<[boolean, boolean]> = [];
		const Body = memo(function Body() {
			const mobile = useMobileViewport();
			const safeArea = useContext(RouteSafeArea);
			childValues.push([mobile, safeArea]);
			return null;
		});
		function Route() {
			const mobile = useMobileViewport();
			parentValues.push(mobile);
			return (
				<RouteSafeArea.Provider value={mobile}>
					<Body />
				</RouteSafeArea.Provider>
			);
		}
		await act(async () => root.render(<Route />));
		await act(async () => media.emit(true));
		expect(parentValues).toEqual([false, true]);
		expect(childValues).toEqual([
			[false, false],
			[true, true],
		]);
	});

	test("a parent-initiated render reads changed matches before native notification", async () => {
		const values: boolean[] = [];
		function Parent({ revision }: { revision: number }) {
			return (
				<div data-revision={revision}>
					<Consumer values={values} />
				</div>
			);
		}
		await act(async () => root.render(<Parent revision={0} />));
		media.setMatches(true);
		await act(async () => root.render(<Parent revision={1} />));
		expect(values).toEqual([false, true]);
		await act(async () => media.emit(true));
		expect(values).toEqual([false, true]);
		expect(media.counts).toEqual({ queries: 1, adds: 1, removes: 0 });
	});

	test("default memo still permits prop and local/ws-state updates", async () => {
		const values: Array<[boolean, number, number]> = [];
		let updateLocal: (value: number) => void = () => {};
		const Body = memo(function Body({ revision }: { revision: number }) {
			const mobile = useMobileViewport();
			const [local, setLocal] = useState(0);
			updateLocal = setLocal;
			values.push([mobile, revision, local]);
			return null;
		});
		await act(async () => root.render(<Body revision={0} />));
		await act(async () => root.render(<Body revision={1} />));
		await act(async () => updateLocal(1));
		await act(async () => media.emit(true));
		expect(values).toEqual([
			[false, 0, 0],
			[false, 1, 0],
			[false, 1, 1],
			[true, 1, 1],
		]);
		expect(media.counts).toEqual({ queries: 1, adds: 1, removes: 0 });
	});

	test.each([
		false,
		true,
	])("last unsubscribe cleans up; remount reads live matches (legacy=%s)", async (legacy) => {
		if (legacy) media = installWindow(false, true);
		const first: boolean[] = [];
		const second: boolean[] = [];
		await act(async () =>
			root.render(
				<>
					<Consumer key="first" values={first} />
					<Consumer key="second" values={second} />
				</>,
			),
		);
		await act(async () => root.render(<Consumer key="second" values={second} />));
		expect(media.listeners.size).toBe(1);
		expect(media.counts.removes).toBe(0);
		await act(async () => root.render(null));
		expect(media.listeners.size).toBe(0);
		expect(media.counts.removes).toBe(1);
		media.setMatches(true);
		const remounted: boolean[] = [];
		await act(async () => root.render(<Consumer values={remounted} />));
		expect(remounted).toEqual([true]);
		expect(media.counts).toEqual({ queries: 1, adds: 2, removes: 1 });
	});

	test("replacing window changes stores and removes the old window listener", async () => {
		const values: boolean[] = [];
		await act(async () => root.render(<Consumer values={values} />));
		const previous = media;
		media = installWindow(true);
		await act(async () => root.render(<Consumer values={values} />));
		expect(values).toEqual([false, true]);
		expect(previous.listeners.size).toBe(0);
		expect(previous.counts.removes).toBe(1);
		expect(media.counts).toEqual({ queries: 1, adds: 1, removes: 0 });
		await act(async () => previous.emit(false));
		expect(values).toEqual([false, true]);
	});

	test("SSR without window returns false; a window without matchMedia has no listener", async () => {
		const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		Reflect.deleteProperty(globalThis, "window");
		const serverValues: boolean[] = [];
		try {
			expect(renderToString(<Consumer values={serverValues} />)).toBe("<output>false</output>");
			expect(serverValues).toEqual([false]);
		} finally {
			if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
		}
		const values: boolean[] = [];
		media = installWindow(false, false, false);
		await act(async () => root.render(<Consumer values={values} />));
		expect(values).toEqual([false]);
		expect(media.counts).toEqual({ queries: 0, adds: 0, removes: 0 });
		media = installWindow(true);
		await act(async () => root.render(<Consumer values={values} />));
		expect(values).toEqual([false, true]);
		expect(media.listeners.size).toBe(1);
	});
});
