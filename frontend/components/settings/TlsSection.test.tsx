/**
 * TlsSection.test.tsx — the SAN editor must survive status refetches.
 *
 * The regression this pins: the editor re-initialized from the TLS status query on
 * EVERY data arrival. React Query refetches on window focus (the app's staleTime is
 * 5s), so tabbing away to copy a hostname and coming back silently discarded every
 * SAN entry the user had typed but not issued yet — the exact stale-snapshot clobber
 * the server-side SAN sidecar exists to prevent. Initialization now happens once per
 * mount; later snapshots never touch the editor.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import en from "../../locales/en/settings.json";
import zh from "../../locales/zh-CN/settings.json";

const realReactI18nextModule = { ...(await import("react-i18next")) };
// Both module mocks MUST spread the real modules: bun's mock.module is process-global
// for modules loaded afterwards, and other test files' graphs import named exports
// (`QueryClient`, `clearTokenOnSessionFailure`, …) from these same modules — a bare
// factory would erase them and fail those files at link time.
const realApiModule = { ...(await import("../../lib/api")) };
const realReactQueryModule = { ...(await import("@tanstack/react-query")) };
const queryClient = new realReactQueryModule.QueryClient({
	defaultOptions: { mutations: { retry: false } },
});
const saveSettings = mock(async (patch: Record<string, unknown>) => patch);

/** Controllable query result: swapping `.current` simulates a refetch landing. */
const queryState: { current: { data: unknown } } = { current: { data: undefined } };

// Keep keys translation-stable while exposing SAN interpolation for status assertions.
// The trust-guide modal needs returnObjects to yield an array.
mock.module("react-i18next", () => ({
	...realReactI18nextModule,
	useTranslation: () => ({
		t: (key: string, opts?: { returnObjects?: boolean; sans?: string }) =>
			opts?.returnObjects ? [`${key}-step`] : opts?.sans ? `${key}: ${opts.sans}` : key,
		i18n: { language: "en" },
	}),
}));
mock.module("@tanstack/react-query", () => ({
	...realReactQueryModule,
	useQuery: () => queryState.current,
	useQueryClient: () => queryClient,
}));
mock.module("../../lib/api", () => ({
	...realApiModule,
	api: {
		...realApiModule.api,
		getTlsStatus: async () => queryState.current.data,
		updateSettings: saveSettings,
		generateTlsWithCa: async () => {
			throw new Error("not exercised by this test");
		},
		regenerateTlsCa: async () => {
			throw new Error("not exercised by this test");
		},
		downloadTlsCa: async () => {
			throw new Error("not exercised by this test");
		},
	},
}));

const { TlsSection } = await import("./TlsSection");
const { useInstanceSettings } = await import("../../hooks/useInstanceSettings");
let settingsForm: ReturnType<typeof useInstanceSettings>;

function SettingsProbe() {
	settingsForm = useInstanceSettings();
	return null;
}

let currentRoot: Root | null = null;
let currentContainer: HTMLElement | null = null;

function setupDom() {
	const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
	const g = globalThis as unknown as Record<string, unknown>;
	g.window = win;
	g.document = win.document;
	g.navigator = win.navigator;
	g.HTMLElement = win.HTMLElement;
	g.Element = win.Element;
	g.Node = win.Node;
	g.getComputedStyle = win.getComputedStyle;
	g.IS_REACT_ACT_ENVIRONMENT = true;
	// linkedom computes no layout and provides no getComputedStyle, but Mantine's
	// Modal/Popover plumbing calls it. Any-property "" stub, the established
	// pattern from useSwipeMenu.scroll-parent.test.ts.
	const computedStyleStub = () =>
		new Proxy(
			{},
			{
				get: (_target, prop) => (prop === "getPropertyValue" ? () => "" : ""),
			},
		);
	if (typeof g.getComputedStyle !== "function") {
		g.getComputedStyle = computedStyleStub;
		// `window.getComputedStyle` is a separate lookup from the bare global, and
		// `win` is type-checked against the DOM lib — go through the untyped view.
		(win as unknown as Record<string, unknown>).getComputedStyle = computedStyleStub;
	}
	if (typeof g.matchMedia !== "function") {
		g.matchMedia = () => ({
			matches: false,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		});
	}
	if (typeof g.ResizeObserver !== "function") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		};
	}
	if (typeof g.requestAnimationFrame !== "function") {
		g.requestAnimationFrame = (cb: (t: number) => void) =>
			setTimeout(() => cb(Date.now()), 0) as unknown as number;
		g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as Timer);
	}
	return win.document;
}

function renderSection(settingsProbe = false): HTMLElement {
	const doc = setupDom();
	const container = doc.createElement("div");
	doc.body.appendChild(container);
	currentContainer = container as unknown as HTMLElement;
	const root = createRoot(currentContainer);
	currentRoot = root;
	act(() => {
		root.render(
			<realReactQueryModule.QueryClientProvider client={queryClient}>
				<MantineProvider>
					{settingsProbe ? <SettingsProbe /> : <TlsSection onCertIssued={() => {}} />}
				</MantineProvider>
			</realReactQueryModule.QueryClientProvider>,
		);
	});
	return currentContainer;
}

/** Re-render with the current query snapshot, flushing effects. */
function rerender() {
	const root = currentRoot;
	if (!root) throw new Error("expected a mounted section");
	act(() => {
		root.render(
			<realReactQueryModule.QueryClientProvider client={queryClient}>
				<MantineProvider>
					<TlsSection onCertIssued={() => {}} />
				</MantineProvider>
			</realReactQueryModule.QueryClientProvider>,
		);
	});
}

afterEach(() => {
	if (currentRoot) {
		const root = currentRoot;
		act(() => root.unmount());
		currentRoot = null;
	}
	currentContainer?.remove();
	currentContainer = null;
	queryState.current = { data: undefined };
	queryClient.clear();
	saveSettings.mockClear();
});

afterAll(() => {
	mock.restore();
});

function tlsStatus(customSans: string[]) {
	return {
		caExists: true,
		caExpiresAt: "2046-01-01T00:00:00.000Z",
		certExists: true,
		certExpiresAt: "2036-01-01T00:00:00.000Z",
		legacySelfSigned: false,
		certSans: [],
		customSans,
		autoSans: ["localhost", "127.0.0.1"],
	};
}

describe("TlsSection — SAN editor initialization", () => {
	test("initializes from the first status snapshot, then ignores refetches", () => {
		// Mount while the query is still loading: no stored SANs to show yet.
		queryState.current = { data: undefined };
		const container = renderSection();
		expect(container.textContent ?? "").not.toContain("nas.local");

		// The first snapshot initializes the editor.
		queryState.current = { data: tlsStatus(["nas.local"]) };
		rerender();
		expect(container.textContent ?? "").toContain("nas.local");

		// A later refetch — e.g. window focus after the user typed new entries, or
		// another admin having issued in the meantime — must NOT reset the editor:
		// the user may have unsubmitted input riding on the current state.
		queryState.current = { data: tlsStatus(["nas.local", "other.home.arpa"]) };
		rerender();
		const text = container.textContent ?? "";
		expect(text).toContain("nas.local");
		expect(text).not.toContain("other.home.arpa");
	});
});

describe("TLS startup update settings", () => {
	for (const savedValue of [undefined, false, true]) {
		test(`loads and saves autoReissue=${savedValue} through the real settings hook`, async () => {
			queryState.current = {
				data: {
					server: { tls: savedValue === undefined ? {} : { autoReissue: savedValue } },
				},
			};
			renderSection(true);
			expect(settingsForm.initialized).toBe(true);
			expect(settingsForm.tlsAutoReissue).toBe(savedValue ?? true);
			expect(settingsForm.isDirty).toBe(false);

			await act(async () => {
				settingsForm.save();
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
			expect(saveSettings).toHaveBeenCalledTimes(1);
			expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({
				server: { tls: { autoReissue: savedValue ?? true } },
			});
		});
	}

	test("the generated setter saves an explicit false and updates the dirty state", async () => {
		queryState.current = { data: {} };
		renderSection(true);
		expect(settingsForm.tlsAutoReissue).toBe(true);
		act(() => settingsForm.setTlsAutoReissue(false));
		expect(settingsForm.tlsAutoReissue).toBe(false);
		expect(settingsForm.isDirty).toBe(true);
		await act(async () => {
			settingsForm.save();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(saveSettings.mock.calls[0]?.[0]).toMatchObject({
			server: { tls: { autoReissue: false } },
		});
		expect(settingsForm.isDirty).toBe(false);
	});

	test("wires the startup update switch and provides both translations", () => {
		const page = readFileSync(new URL("../../routes/settings/server.tsx", import.meta.url), "utf8");
		const section = readFileSync(new URL("./ServerSystemSection.tsx", import.meta.url), "utf8");
		expect(page).toContain("tlsAutoReissue={is.tlsAutoReissue}");
		expect(page).toContain("setTlsAutoReissue={is.setTlsAutoReissue}");
		expect(section).toContain("checked={tlsAutoReissue}");
		expect(section).toContain("setTlsAutoReissue(e.currentTarget.checked)");
		for (const locale of [en, zh]) {
			expect(locale.tlsAutoReissue).toBeTruthy();
			expect(locale.tlsAutoReissueDesc).toContain("CA");
			expect(locale.tlsCertSans).toContain("{{sans}}");
		}
	});
});

describe("TlsSection — re-issue pulse", () => {
	const reissueButton = (c: HTMLElement) => c.querySelector("[data-sans-changed]");

	test("does not pulse when editor matches the certificate", () => {
		queryState.current = {
			data: { ...tlsStatus(["nas.local"]), certSans: ["localhost", "127.0.0.1", "nas.local"] },
		};
		const container = renderSection();
		expect(reissueButton(container)).toBeNull();
	});

	test("pulses when stored SANs differ from the certificate", () => {
		queryState.current = {
			data: { ...tlsStatus(["nas.local"]), certSans: ["localhost", "127.0.0.1"] },
		};
		const container = renderSection();
		expect(reissueButton(container)).not.toBeNull();
	});

	test("shows actual certificate SANs separately from automatic issuance names", () => {
		queryState.current = {
			data: {
				...tlsStatus([]),
				certSans: ["localhost", "192.168.1.10"],
				autoSans: ["localhost", "192.168.1.20"],
			},
		};
		const container = renderSection();
		expect(container.textContent).toContain("tlsCertSans: localhost, 192.168.1.10");
		expect(container.textContent).toContain("tlsAutoSansNote: localhost, 192.168.1.20");
		expect(container.textContent).toContain("tlsSansPendingReissue");
		expect(reissueButton(container)).not.toBeNull();
	});

	test("treats equivalent IPv6 and case-insensitive DNS names as equal", () => {
		queryState.current = {
			data: {
				...tlsStatus(["NAS.local", "2001:db8::1", "localhost"]),
				certSans: [
					"localhost",
					"127.0.0.1",
					"nas.local",
					"0:0:0:0:0:0:0:1",
					"2001:0db8:0:0:0:0:0:1",
				],
				autoSans: ["localhost", "127.0.0.1", "::1"],
			},
		};
		const container = renderSection();
		expect(reissueButton(container)).toBeNull();
		expect(container.textContent).not.toContain("tlsSansPendingReissue");
	});

	test("does not suggest re-issuing when no certificate exists", () => {
		queryState.current = { data: { ...tlsStatus(["nas.local"]), certExists: false } };
		const container = renderSection();
		expect(reissueButton(container)).toBeNull();
		expect(container.textContent).not.toContain("tlsSansPendingReissue");
		expect(container.textContent).not.toContain("tlsCertSans");
	});

	test("pulses when a SAN was removed but the cert still has it", () => {
		queryState.current = {
			data: { ...tlsStatus([]), certSans: ["localhost", "127.0.0.1", "nas.local"] },
		};
		const container = renderSection();
		expect(reissueButton(container)).not.toBeNull();
	});
});
