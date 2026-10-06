import { afterEach, beforeAll, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RenderLodCtx } from "../narrator/lod/RenderLodCtx";
import { sliceBracketedRegion } from "../narrator/vlist/source-slice";
import type { VListDataSource } from "../narrator/vlist/vlist-data-source";
import { createVListInteractionAdmission } from "../narrator/vlist/vlist-interaction-admission";

// Keep lazy-child mocks and DOM globals out of other test files, including fast runs.
if (process.env.NF_PUBLIC_ADMISSION_CHILD !== "1") {
	it("runs the actual public entry and admission wiring suite in an isolated process", async () => {
		const child = Bun.spawn([process.execPath, "test", "--isolate", import.meta.path], {
			env: { ...process.env, NF_PUBLIC_ADMISSION_CHILD: "1", NARRAFORK_HOME: undefined },
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
	const listSource = readFileSync(
		new URL("../narrator/vlist/PretextExactMessageList.tsx", import.meta.url),
		"utf8",
	);
	const shareSource = readFileSync(
		new URL("./PublicSharedNarratorPage.tsx", import.meta.url),
		"utf8",
	);

	it("defaults to admission and projects only the explicit flag to a nullable owner", () => {
		expect(listSource).toMatch(/deferInteractions\?: boolean/);
		const props = sliceBracketedRegion(listSource, "const {");
		expect(props).not.toBeNull();
		expect(props).toContain("deferInteractions = true");
		const owner = sliceBracketedRegion(listSource, "const interactionOwner = useMemo(");
		if (!owner) throw new Error("Missing production interaction owner");
		expect(owner).toMatch(/\[narratorId, deferInteractions\]/);
		expect(owner).not.toMatch(/dataSource|interactive/);
		let creations = 0;
		const store = {};
		// Execute the bounded production owner factory, not a duplicate of its branching logic.
		const project = new Function(
			"useMemo",
			"createVListInteractionAdmission",
			"narratorId",
			"deferInteractions",
			"dataSource",
			`${owner}; return interactionOwner;`,
		);
		for (const dataSource of [undefined, { fetchPage: () => {} }]) {
			for (const flag of [true, false]) {
				const result = project(
					(factory: () => unknown) => factory(),
					() => {
						creations++;
						return store;
					},
					"synthetic-narrator",
					flag,
					dataSource,
				);
				expect(result).toEqual({
					narratorId: "synthetic-narrator",
					admission: flag ? store : null,
				});
			}
		}
		expect(creations).toBe(2);
		expect(listSource).toContain("const interactionAdmission = interactionOwner.admission;");
		expect(listSource).toMatch(
			/<VListInteractionAdmissionContext.Provider value=\{interactionAdmission\}>\s*\{windowRowElements\}\s*<\/VListInteractionAdmissionContext.Provider>/,
		);
	});

	it("disabled admission registers no visibility/scrollend listeners and cleans the previous owner", () => {
		const start = listSource.indexOf("const syncAdmissionVisibility =");
		expect(start).toBeGreaterThan(0);
		const effectStart = listSource.lastIndexOf("useEffect(() => {", start);
		const effects = sliceBracketedRegion(listSource.slice(effectStart), "useEffect(");
		if (!effects) throw new Error("Missing admission visibility effect");
		expect(effects).toMatch(/if \(!interactionAdmission\) return;/);
		expect(effects).toContain("interactionAdmission.suspend()");
		expect(effects).toContain('document.removeEventListener("visibilitychange"');
		const scrollEndStart = listSource.indexOf("const onScrollEnd =");
		expect(scrollEndStart).toBeGreaterThan(start);
		const scrollEffect = sliceBracketedRegion(
			listSource.slice(listSource.lastIndexOf("useEffect(() => {", scrollEndStart)),
			"useEffect(",
		);
		expect(scrollEffect).not.toBeNull();
		expect(scrollEffect).toMatch(/if \(!interactionAdmission \|\| !viewportNode\) return;/);
		expect(scrollEffect).toContain('viewportNode.removeEventListener("scrollend"');
		expect(listSource).not.toMatch(
			/interactionAdmissionRef\.current\.(observeScroll|markHistoryIntent|setAtBottom)/,
		);

		// Execute both production effects through an effect runner. This covers their
		// disabled early exits and old-owner cleanup, without mounting the query/WS shell.
		const cleanups: (() => void)[] = [];
		const listeners = new Map<string, EventListener>();
		const timers = new Set<number>();
		let serial = 0;
		const events = {
			hidden: false,
			addEventListener: mock((name: string, callback: EventListener) => {
				listeners.set(name, callback);
			}),
			removeEventListener: mock((name: string) => listeners.delete(name)),
		};
		const runEffects = new Function(
			"useEffect",
			"interactionAdmission",
			"panelVisible",
			"document",
			"pinnedToBottomRef",
			"textReadingDetachedRef",
			"viewportNode",
			new Bun.Transpiler({ loader: "ts" }).transformSync(`${effects}; ${scrollEffect};`),
		);
		const store = createVListInteractionAdmission({
			runtime: {
				now: () => 0,
				setTimeout: () => {
					const id = ++serial;
					timers.add(id);
					return id;
				},
				clearTimeout: (id) => void timers.delete(id),
				requestAnimationFrame: () => ++serial,
				cancelAnimationFrame() {},
			},
		});
		store.markHistoryIntent();
		const run = (owner: typeof store | null) =>
			runEffects(
				(callback: () => (() => void) | undefined) => {
					const cleanup = callback();
					if (cleanup) cleanups.push(cleanup);
				},
				owner,
				true,
				events,
				{ current: false },
				{ current: false },
				events,
			);
		run(store);
		expect([...listeners.keys()]).toEqual(["visibilitychange", "scrollend"]);
		expect(timers.size).toBe(1);
		for (const cleanup of cleanups.splice(0)) cleanup();
		expect(listeners.size).toBe(0);
		expect(timers.size).toBe(0);
		expect(store.getDebugSnapshot().suspended).toBe(true);
		events.addEventListener.mockClear();
		run(null);
		expect(events.addEventListener).not.toHaveBeenCalled();
		expect(cleanups).toEqual([]);
		expect(timers.size).toBe(0);
		const replacementStore = createVListInteractionAdmission();
		run(replacementStore);
		expect(listeners.size).toBe(2);
		expect(replacementStore.getDebugSnapshot().suspended).toBe(false);
		expect(store.getDebugSnapshot().suspended).toBe(true);
		for (const cleanup of cleanups.splice(0)) cleanup();
		expect(timers.size).toBe(0);
	});

	it("keeps the production lazy import boundary", () => {
		expect(shareSource).toContain('import("../narrator/vlist/PretextExactMessageList")');
		expect(shareSource).not.toMatch(/from ["']\.\.\/narrator\/vlist\/PretextExactMessageList/);
	});

	type ListProps = { narratorId: string; dataSource: VListDataSource; deferInteractions?: boolean };
	const captured = new Map<string, { props: ListProps; interactive: boolean }>();
	mock.module("../narrator/vlist/PretextExactMessageList", () => ({
		PretextExactMessageList: (props: ListProps) => {
			captured.set(props.narratorId, { props, interactive: useContext(RenderLodCtx).interactive });
			return <div data-list={props.narratorId} />;
		},
	}));
	mock.module("../narrator/lod/NarratorLodMenu", () => ({ NarratorLodMenu: () => null }));
	mock.module("../../hooks/useNarratorLod", () => ({
		useNarratorLod: () => ({ lod: 4, isDefault: true, setLod() {}, setAsDefault() {} }),
	}));
	const i18n = { resolvedLanguage: "en", hasResourceBundle: () => true };
	mock.module("react-i18next", () => ({
		useTranslation: () => ({ t: (key: string) => key, i18n }),
	}));
	mock.module("../../lib/i18n", () => ({
		ensureI18nNamespaces: async () => {},
		changeAppLanguage: async () => {},
	}));
	mock.module("../../hooks/usePublicSharedNarrator", () => ({
		usePublicSharedNarrator: () => ({
			client: {},
			controller: {},
			state: {
				phase: "live",
				session: {
					shareId: "fixture-share",
					narratorId: "fixture-narrator",
					roomId: "fixture-discussion",
					title: "Synthetic public share",
					status: "idle",
					messageVersion: 0,
					guestName: "Fixture guest",
				},
			},
		}),
	}));
	let root: Root | undefined;
	let container: HTMLElement;
	let PublicSharedNarratorPage: typeof import("./PublicSharedNarratorPage").PublicSharedNarratorPage;
	beforeAll(async () => {
		const { window } = parseHTML("<html><head></head><body></body></html>");
		Object.assign(window, {
			matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
			getComputedStyle: () => ({ getPropertyValue: () => "", direction: "ltr" }),
		});
		Object.assign(window.document, { fonts: { addEventListener() {}, removeEventListener() {} } });
		Object.assign(globalThis, {
			ResizeObserver: class {
				observe() {}
				unobserve() {}
				disconnect() {}
			},
			MutationObserver: window.MutationObserver,
			window,
			document: window.document,
			navigator: window.navigator,
			HTMLElement: window.HTMLElement,
			Element: window.Element,
			Node: window.Node,
			getComputedStyle: window.getComputedStyle,
			IS_REACT_ACT_ENVIRONMENT: true,
		});
		({ PublicSharedNarratorPage } = await import("./PublicSharedNarratorPage"));
	});
	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
		container?.remove();
		captured.clear();
	});
	it("the actual read-only public session explicitly opts out while discussion retains the default", async () => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () => {
			root?.render(
				<MantineProvider env="test">
					<PublicSharedNarratorPage shareId="fixture-share" credential="synthetic-token" />
				</MantineProvider>,
			);
		});
		expect(captured.size).toBe(2);
		const session = captured.get("fixture-narrator");
		expect(session?.interactive).toBe(false);
		expect(session?.props.deferInteractions).toBe(false);
		expect(session?.props.dataSource).toBeDefined();
		const discussion = captured.get("fixture-discussion");
		expect(discussion?.props.deferInteractions).toBeUndefined();
		expect(discussion?.props.dataSource).toBeDefined();
	});
}
