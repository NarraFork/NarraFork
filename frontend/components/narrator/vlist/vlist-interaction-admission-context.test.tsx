import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";
import { act, StrictMode, Suspense, startTransition, useEffect, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
	createVListInteractionAdmission,
	type VListInteractionAdmissionRuntime,
	type VListInteractionAdmissionStore,
} from "./vlist-interaction-admission";
import {
	useDeferredInteractionMount,
	VListInteractionAdmissionContext,
	type VListInteractionRowBounds,
	VListInteractionRowBoundsContext,
} from "./vlist-interaction-admission-context";

// The real React suite gets its own DOM globals even when invoked by a non-isolated runner.
if (process.env.NF_ADMISSION_CONTEXT_TEST_CHILD !== "1") {
	it("runs the real admission hook lifecycle suite in an isolated process", async () => {
		const child = Bun.spawn([process.execPath, "test", "--isolate", import.meta.path], {
			env: { ...process.env, NARRAFORK_HOME: undefined, NF_ADMISSION_CONTEXT_TEST_CHILD: "1" },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
	}, 20000);
} else {
	function clock() {
		let now = 0;
		let nextId = 0;
		const timers = new Map<number, { at: number; callback: () => void }>();
		const frames = new Map<number, () => void>();
		const runtime: VListInteractionAdmissionRuntime = {
			now: () => now,
			setTimeout(callback, delay) {
				const id = ++nextId;
				timers.set(id, { at: now + delay, callback });
				return id;
			},
			clearTimeout: (id) => void timers.delete(id),
			requestAnimationFrame(callback) {
				const id = ++nextId;
				frames.set(id, callback);
				return id;
			},
			cancelAnimationFrame: (id) => void frames.delete(id),
		};
		return {
			runtime,
			advance(ms: number) {
				now += ms;
				for (const [id, timer] of [...timers]) {
					if (timer.at > now || !timers.delete(id)) continue;
					timer.callback();
				}
			},
			frame() {
				for (const [id, callback] of [...frames]) {
					if (frames.delete(id)) callback();
				}
			},
			jobs: () => ({ timers: timers.size, frames: frames.size }),
		};
	}
	type RowSpec = {
		id: string;
		bounds?: VListInteractionRowBounds;
		immediate?: boolean;
		enabled?: boolean;
		onLayout?: () => void;
	};
	let root: Root | undefined;
	let container: HTMLElement;
	const ensures = new Map<string, () => void>();
	const renders = new Map<string, number>();
	const warmMounts = new Map<string, number>();
	const warmUnmounts = new Map<string, number>();
	const cleanupGeometry: (() => void)[] = [];
	const never = new Promise<void>(() => {});

	function WarmContent({ id }: { id: string }) {
		useEffect(() => {
			warmMounts.set(id, (warmMounts.get(id) ?? 0) + 1);
			return () => {
				warmUnmounts.set(id, (warmUnmounts.get(id) ?? 0) + 1);
			};
		}, [id]);
		return <i data-warm={id} />;
	}
	function Row({ id, immediate, enabled, onLayout }: RowSpec) {
		const result = useDeferredInteractionMount({ immediate, enabled });
		renders.set(id, (renders.get(id) ?? 0) + 1);
		useLayoutEffect(() => {
			onLayout?.();
		}, [onLayout]);
		useEffect(() => {
			ensures.set(id, result.ensure);
			return () => {
				ensures.delete(id);
			};
		}, [id, result.ensure]);
		return (
			<span data-id={id} data-ready={String(result.ready)}>
				{result.ready && <WarmContent id={id} />}
			</span>
		);
	}
	function AbandonedRow(): never {
		useDeferredInteractionMount({ immediate: true });
		throw never;
	}
	function Harness({
		store,
		rows,
		abandoned = false,
	}: {
		store: VListInteractionAdmissionStore | null;
		rows: RowSpec[];
		abandoned?: boolean;
	}) {
		useEffect(() => {
			store?.resume();
			return () => store?.suspend();
		}, [store]);
		return (
			<VListInteractionAdmissionContext.Provider value={store}>
				{rows.map((row) => (
					<VListInteractionRowBoundsContext.Provider key={row.id} value={row.bounds ?? null}>
						<Row {...row} />
					</VListInteractionRowBoundsContext.Provider>
				))}
				{abandoned && (
					<Suspense fallback={null}>
						<AbandonedRow />
					</Suspense>
				)}
			</VListInteractionAdmissionContext.Provider>
		);
	}
	async function render(
		store: VListInteractionAdmissionStore | null,
		rows: RowSpec[],
		abandoned = false,
	) {
		if (!root) {
			container = document.createElement("div");
			document.body.append(container);
			root = createRoot(container);
		}
		await act(async () => {
			root?.render(
				<StrictMode>
					<Harness store={store} rows={rows} abandoned={abandoned} />
				</StrictMode>,
			);
		});
	}
	function ready(id: string) {
		return container.querySelector(`[data-id="${id}"]`)?.getAttribute("data-ready") === "true";
	}
	function setup() {
		const time = clock();
		const store = createVListInteractionAdmission({ runtime: time.runtime });
		store.observeScroll({ scrollTop: 100, viewportHeight: 100, atBottom: false });
		return { time, store };
	}
	beforeAll(() => {
		const { window } = parseHTML("<html><body></body></html>");
		Object.assign(globalThis, {
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		for (const key of [
			"offsetTop",
			"offsetHeight",
			"offsetWidth",
			"clientHeight",
			"clientWidth",
			"scrollHeight",
			"scrollTop",
			"getBoundingClientRect",
		]) {
			const prototype = window.HTMLElement.prototype;
			const original = Object.getOwnPropertyDescriptor(prototype, key);
			Object.defineProperty(prototype, key, {
				configurable: true,
				get() {
					throw new Error(`Forbidden geometry read: ${key}`);
				},
			});
			cleanupGeometry.push(() => {
				if (original) Object.defineProperty(prototype, key, original);
				else Reflect.deleteProperty(prototype, key);
			});
		}
	});
	afterAll(() => {
		for (const cleanup of cleanupGeometry) cleanup();
	});
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
		container?.remove();
		ensures.clear();
		renders.clear();
		warmMounts.clear();
		warmUnmounts.clear();
	});

	describe("useDeferredInteractionMount real React lifecycle", () => {
		it.each([
			"history",
			"hidden",
		] as const)("revalidates an eager render before concurrent commit: %s", async (change) => {
			const time = clock();
			const store = createVListInteractionAdmission({ runtime: time.runtime });
			let changed = false;
			function RacingRow() {
				const result = useDeferredInteractionMount();
				// Simulate owner activity after the hook snapshot but before commit.
				// The test mutates only its fake-clock store, not another React state.
				if (result.ready && !changed) {
					changed = true;
					if (change === "history") store.markHistoryIntent();
					else store.suspend();
				}
				return (
					<span data-id="racing" data-ready={String(result.ready)}>
						{result.ready && <WarmContent id="racing" />}
					</span>
				);
			}
			container = document.createElement("div");
			document.body.append(container);
			root = createRoot(container);
			await act(async () => {
				startTransition(() => {
					root?.render(
						<StrictMode>
							<VListInteractionAdmissionContext.Provider value={store}>
								<RacingRow />
							</VListInteractionAdmissionContext.Provider>
						</StrictMode>,
					);
				});
			});
			expect(changed).toBe(true);
			expect(ready("racing")).toBe(false);
			expect(warmMounts.get("racing") ?? 0).toBe(0);
			expect(store.getDebugSnapshot()).toMatchObject({ active: 1, pending: 1 });
			await act(async () => {
				if (change === "history") {
					time.advance(120);
					time.frame();
				} else store.resume(true);
			});
			expect(ready("racing")).toBe(true);
			const node = container.querySelector('[data-warm="racing"]');
			const mounts = warmMounts.get("racing");
			await act(async () => {
				store.markHistoryIntent();
				store.suspend();
			});
			expect(ready("racing")).toBe(true);
			expect(container.querySelector('[data-warm="racing"]')).toBe(node);
			expect(warmMounts.get("racing")).toBe(mounts);
		});

		it("cold mount waits for idle batches, prioritizes visible bounds, then remains sticky", async () => {
			const { time, store } = setup();
			const rows = [
				{ id: "off1", bounds: { top: 1000, height: 20 } },
				{ id: "off2", bounds: { top: 500, height: 20 } },
				{ id: "visible1", bounds: { top: 110, height: 20 } },
				{ id: "visible2", bounds: { top: 170, height: 20 } },
				{ id: "off3", bounds: { top: 600, height: 20 } },
			];
			await render(store, rows);
			expect(rows.every((row) => !ready(row.id))).toBe(true);
			expect(store.getDebugSnapshot()).toMatchObject({ active: 5, pending: 5 });
			const baseline = new Map(renders);
			await act(async () => time.advance(120));
			expect(renders).toEqual(baseline);
			await act(async () => time.frame());
			expect(ready("visible1")).toBe(true);
			expect(ready("visible2")).toBe(true);
			expect(ready("off1")).toBe(false);
			expect(renders.get("off1")).toBe(baseline.get("off1"));
			await act(async () => time.frame());
			expect(ready("off1")).toBe(true);
			expect(ready("off2")).toBe(true);
			expect(ready("off3")).toBe(false);
			await act(async () => {
				store.observeScroll({ scrollTop: 120, viewportHeight: 100, atBottom: false });
			});
			const warmRenders = new Map(renders);
			await act(async () => time.frame());
			expect(ready("off3")).toBe(false);
			expect(renders).toEqual(warmRenders);
			await act(async () => store.setAtBottom(true));
			expect(ready("off3")).toBe(true);
			expect(renders.get("visible1")).toBe(warmRenders.get("visible1"));
		});

		it("immediate exempts this render and commits sticky ensure without opening other rows", async () => {
			const { store } = setup();
			await render(store, [{ id: "immediate", immediate: true }, { id: "cold" }]);
			expect(ready("immediate")).toBe(true);
			expect(ready("cold")).toBe(false);
			expect(store.getDebugSnapshot().pending).toBe(1);
			const ensure = ensures.get("immediate");
			await render(store, [{ id: "immediate" }, { id: "cold" }]);
			expect(ready("immediate")).toBe(true);
			expect(ensures.get("immediate")).toBe(ensure);
			expect(store.getPhase()).toBe("history-scrolling");
		});

		it("row-bounds immediate commits sticky admission during layout and revocation never unmounts controls", async () => {
			const { store } = setup();
			const createLease = store.createLease;
			const createdLeases: ReturnType<VListInteractionAdmissionStore["createLease"]>[] = [];
			store.createLease = (options) => {
				const lease = createLease(options);
				createdLeases.push(lease);
				return lease;
			};
			const layoutSnapshots: boolean[] = [];
			await render(store, [
				{
					id: "inherited",
					immediate: false,
					bounds: { top: 100, height: 20, immediate: true },
					// StrictMode may create extra abandoned leases; the committed one is sticky in layout.
					onLayout: () => layoutSnapshots.push(createdLeases.some((lease) => lease.getSnapshot())),
				},
			]);
			expect(layoutSnapshots.length).toBeGreaterThan(0);
			expect(layoutSnapshots.every(Boolean)).toBe(true);
			expect(ready("inherited")).toBe(true);
			expect(store.getDebugSnapshot()).toMatchObject({ phase: "history-scrolling", pending: 0 });
			const node = container.querySelector('[data-warm="inherited"]');
			const mounts = warmMounts.get("inherited");
			const unmounts = warmUnmounts.get("inherited");
			const ensure = ensures.get("inherited");
			await render(store, [
				{ id: "inherited", bounds: { top: 100, height: 20, immediate: false } },
				{ id: "cold", bounds: { top: 150, height: 20 } },
			]);
			expect(ready("inherited")).toBe(true);
			expect(ready("cold")).toBe(false);
			expect(container.querySelector('[data-warm="inherited"]')).toBe(node);
			expect(warmMounts.get("inherited")).toBe(mounts);
			expect(warmUnmounts.get("inherited")).toBe(unmounts);
			expect(ensures.get("inherited")).toBe(ensure);
			expect(store.getDebugSnapshot()).toMatchObject({ phase: "history-scrolling", pending: 1 });
		});

		it("disabled rows create no lease, are ready with noop ensure, and can enable later", async () => {
			const { store, time } = setup();
			let created = 0;
			const createLease = store.createLease;
			store.createLease = (options) => {
				created++;
				return createLease(options);
			};
			await render(store, [{ id: "optional", enabled: false, immediate: true }]);
			expect(created).toBe(0);
			expect(ready("optional")).toBe(true);
			expect(store.getDebugSnapshot()).toMatchObject({ active: 0, pending: 0 });
			const noop = ensures.get("optional");
			await act(async () => noop?.());
			expect(store.getPhase()).toBe("history-scrolling");
			await render(store, [{ id: "optional", enabled: false }]);
			expect(ensures.get("optional")).toBe(noop);
			expect(created).toBe(0);
			await render(store, [{ id: "optional" }]);
			expect(created).toBeGreaterThan(0);
			expect(ready("optional")).toBe(false);
			expect(store.getDebugSnapshot()).toMatchObject({ active: 1, pending: 1 });
			const enabledCount = created;
			await render(store, [{ id: "optional", enabled: false }]);
			expect(created).toBe(enabledCount);
			expect(ready("optional")).toBe(true);
			expect(store.getDebugSnapshot()).toMatchObject({ active: 0, pending: 0 });
			await act(async () => time.advance(120));
			expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
			await render(store, [{ id: "optional", enabled: true }]);
			expect(ready("optional")).toBe(false);
			await act(async () => time.frame());
			expect(ready("optional")).toBe(true);
		});

		it("first-user-intent ensure is stable and affects only that component", async () => {
			const { store } = setup();
			await render(store, [{ id: "one" }, { id: "two" }]);
			const ensure = ensures.get("one");
			await act(async () => ensure?.());
			expect(ready("one")).toBe(true);
			expect(ready("two")).toBe(false);
			expect(ensures.get("one")).toBe(ensure);
			expect(store.getDebugSnapshot()).toMatchObject({ phase: "history-scrolling", pending: 1 });
		});

		it("committed bounds changes update priority without recreating or warming a lease", async () => {
			const { store, time } = setup();
			await render(store, [
				{ id: "moving", bounds: { top: 1000, height: 10 } },
				{ id: "off1", bounds: { top: 1000, height: 10 } },
				{ id: "off2", bounds: { top: 1000, height: 10 } },
			]);
			const ensure = ensures.get("moving");
			await render(store, [
				{ id: "moving", bounds: { top: 130, height: 10 } },
				{ id: "off1", bounds: { top: 1000, height: 10 } },
				{ id: "off2", bounds: { top: 1000, height: 10 } },
			]);
			expect(ensures.get("moving")).toBe(ensure);
			await act(async () => time.advance(120));
			await act(async () => time.frame());
			expect(ready("moving")).toBe(true);
			expect(ready("off1")).toBe(true);
			expect(ready("off2")).toBe(false);
		});

		it("unmount removes cold leases and all owner timers/frames; StrictMode does not dispose leases", async () => {
			const { store, time } = setup();
			await render(store, [{ id: "one" }, { id: "two" }]);
			await act(async () => time.advance(120));
			expect(time.jobs().frames).toBe(1);
			await render(store, [{ id: "one" }]);
			expect(store.getDebugSnapshot()).toMatchObject({ active: 1, pending: 1 });
			await act(async () => time.frame());
			expect(ready("one")).toBe(true);
			await act(async () => root?.unmount());
			root = undefined;
			expect(store.getDebugSnapshot()).toMatchObject({ active: 0, pending: 0, suspended: true });
			expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
		});

		it("owner changes reset sticky readiness and unsubscribe the previous store", async () => {
			const old = setup();
			await render(old.store, [{ id: "one" }]);
			await act(async () => ensures.get("one")?.());
			expect(ready("one")).toBe(true);
			const next = setup();
			await render(next.store, [{ id: "one" }]);
			expect(ready("one")).toBe(false);
			expect(old.store.getDebugSnapshot()).toMatchObject({
				active: 0,
				pending: 0,
				suspended: true,
			});
			expect(old.time.jobs()).toEqual({ timers: 0, frames: 0 });
			await act(async () => next.time.advance(120));
			await act(async () => next.time.frame());
			expect(ready("one")).toBe(true);
		});

		it("null/no provider remains eager for public shares and server rendering", async () => {
			await render(null, [{ id: "one" }, { id: "disabled", enabled: false }]);
			expect(ready("one")).toBe(true);
			expect(ready("disabled")).toBe(true);
			await act(async () => ensures.get("one")?.());
			expect(renderToString(<Row id="ssr" />)).toContain('data-ready="true"');
			expect(renderToString(<Row id="ssr-disabled" enabled={false} />)).toContain(
				'data-ready="true"',
			);
			const { store } = setup();
			await render(store, [{ id: "one" }]);
			expect(ready("one")).toBe(false);
			await render(null, [{ id: "one" }]);
			expect(ready("one")).toBe(true);
			expect(store.getDebugSnapshot().pending).toBe(0);
		});

		it("abandoned Suspense renders do not publish leases or immediate exemptions", async () => {
			const { store, time } = setup();
			await render(store, [], true);
			expect(store.getDebugSnapshot()).toMatchObject({ pending: 0, active: 0 });
			await act(async () => time.advance(120));
			expect(time.jobs()).toEqual({ timers: 0, frames: 0 });
		});
	});
}
