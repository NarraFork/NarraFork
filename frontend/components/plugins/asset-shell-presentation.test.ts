import { describe, expect, test } from "bun:test";
import { createPluginAssetShell } from "./asset-shell";
import { TOKEN_STYLE_ELEMENT_ID } from "./host-tokens";
import { translatePluginString } from "./plugin-i18n";

/**
 * The theme and language plumbing inside the generated shell.
 *
 * ## Why this file exists separately from `plugin-i18n.test.ts`
 *
 * The shell's `i18n.t()` is a SECOND implementation of the lookup, written inline because the
 * shell is a template string with no module loader and therefore cannot import
 * `plugin-i18n.ts`. Two implementations of one rule can drift, and the symptom would be a panel
 * translating differently from the host with nothing to attribute it to. So the inline copy is
 * executed here and compared against the host module on the same inputs.
 *
 * The shell code is extracted from the generated HTML and run through `new Function`, which also
 * makes a syntax error in the template a test failure rather than a blank panel at runtime.
 */

const baseOptions = {
	nonce: "n".repeat(32),
	pluginId: "com.example.panel",
	contributionId: "settings",
	panelInstanceId: "pui_settings",
	entryUrl: "/api/plugins/ui/assets/x/entry.js",
};

function shellScript(overrides: Record<string, unknown> = {}): string {
	const html = createPluginAssetShell({ ...baseOptions, ...overrides });
	const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
	if (!match?.[1]) throw new Error("shell has no inline script");
	return match[1];
}

/**
 * Run the shell in a minimal fake document and return what it built.
 *
 * Only the handful of DOM APIs the bootstrap touches before the handshake are provided. A real
 * DOM is not needed and would obscure which capabilities the shell actually depends on.
 */
interface ShellSdk {
	onNotification: (listener: (message: unknown) => void) => () => void;
	i18n: {
		locale: string;
		t: (tables: unknown, key: string, params?: unknown) => string;
		onChange: (listener: (locale: string) => void) => () => void;
	};
}

function runShell(overrides: Record<string, unknown> = {}) {
	const head: Array<Record<string, unknown>> = [];
	const created: Array<Record<string, unknown>> = [];
	const windowListeners = new Map<string, (event: unknown) => void>();
	/** Notifications the shell delivers to the plugin side of the port. */
	const portListeners = new Map<string, (event: unknown) => void>();
	const posted: unknown[] = [];

	const makeElement = (tag: string) => {
		const element: Record<string, unknown> = { tagName: tag, textContent: "", id: "" };
		created.push(element);
		return element;
	};
	const documentStub = {
		createElement: makeElement,
		head: {
			get firstChild() {
				return head[0] ?? null;
			},
			appendChild: (node: Record<string, unknown>) => head.push(node),
			insertBefore: (node: Record<string, unknown>) => head.unshift(node),
		},
	};
	const parent = {};
	const windowStub = {
		addEventListener: (type: string, listener: (event: unknown) => void) => {
			windowListeners.set(type, listener);
		},
		removeEventListener: () => {},
		parent,
	};

	const scope = {
		document: documentStub,
		window: windowStub,
		globalThis: {} as Record<string, unknown>,
		setTimeout,
		clearTimeout,
		TextEncoder,
	};
	scope.globalThis = scope as unknown as Record<string, unknown>;

	const factory = new Function(...Object.keys(scope), shellScript(overrides));
	factory(...Object.values(scope));

	// The SDK is installed on connect, not on load, so the handshake has to be driven for
	// `narrafork` to exist. Token CSS, by contrast, is applied during bootstrap — which is the
	// point, and why it is asserted before this runs.
	const port = {
		addEventListener: (type: string, listener: (event: unknown) => void) => {
			portListeners.set(type, listener);
		},
		start: () => {},
		close: () => {},
		postMessage: (message: unknown) => posted.push(message),
	};
	const connect = windowListeners.get("message");
	if (!connect) throw new Error("shell installed no connect listener");
	connect({
		source: parent,
		ports: [port],
		data: {
			type: "narrafork:ui-connect",
			protocol: "narrafork.ui/1",
			nonce: baseOptions.nonce,
			pluginId: baseOptions.pluginId,
			contributionId: baseOptions.contributionId,
			panelInstanceId: baseOptions.panelInstanceId,
			hostProtocolRange: { min: 1, max: 1 },
		},
	});

	const sdk = (scope.globalThis as Record<string, unknown>).narrafork as ShellSdk | undefined;
	if (!sdk) throw new Error("shell did not install the narrafork SDK");
	const tokenStyle = created.find((element) => element.id === TOKEN_STYLE_ELEMENT_ID);

	/** Deliver a host notification over the port, the way the runtime does. */
	const push = (method: string, params: unknown) => {
		const handler = portListeners.get("message");
		if (!handler) throw new Error("shell installed no port message listener");
		handler({ data: { protocol: "narrafork.ui/1", kind: "notification", method, params } });
	};

	return { sdk, tokenStyle, head, push };
}

describe("shell presentation: first frame", () => {
	test("token CSS is injected before the plugin loads", () => {
		// Injected during bootstrap rather than on the handshake: a panel must not paint unstyled
		// and then correct itself.
		const { tokenStyle } = runShell({ tokenCss: ":root {\n\t--nf-color-text: #abcdef;\n}\n" });
		expect(tokenStyle?.textContent).toContain("--nf-color-text: #abcdef");
	});

	test("the token style is prepended, so a plugin stylesheet can still win", () => {
		// A token that overrode the plugin's own CSS would make the panel unstyleable.
		const { tokenStyle, head } = runShell({ tokenCss: ":root { --nf-radius: 4px; }" });
		expect(tokenStyle).toBeDefined();
		expect(head.indexOf(tokenStyle as Record<string, unknown>)).toBe(0);
	});

	test("no token CSS means no style element at all", () => {
		// Not an empty one: an empty custom property still counts as set and would defeat a
		// plugin's `var(--nf-x, fallback)`.
		const { tokenStyle } = runShell();
		expect(tokenStyle).toBeUndefined();
	});

	test("the locale is readable synchronously, without an RPC", () => {
		// `context.get` is async and cannot resolve before the plugin's first render.
		const { sdk } = runShell({ locale: "zh-CN", localeChain: ["zh-CN", "en"] });
		expect(sdk.i18n.locale).toBe("zh-CN");
	});

	test("an omitting caller gets an inert default rather than a broken SDK", () => {
		const { sdk } = runShell();
		expect(sdk.i18n.locale).toBe("en");
		expect(sdk.i18n.t({ en: { k: "v" } }, "k")).toBe("v");
	});
});

describe("shell presentation: the inline lookup matches the host module", () => {
	const tables = {
		en: { signIn: "Sign in", balance: "Balance: {amount}", onlyEnglish: "English only" },
		"zh-CN": { signIn: "登录", balance: "余额：{amount}" },
	};

	test("both implementations agree on every fallback case", () => {
		// The whole point of this file: one rule, two implementations, kept in step by comparison
		// rather than by hope.
		const { sdk } = runShell({ locale: "zh-CN", localeChain: ["zh-CN", "en"] });
		const cases: Array<[string, Record<string, string | number> | undefined]> = [
			["signIn", undefined],
			["onlyEnglish", undefined],
			["missingEverywhere", undefined],
			["balance", { amount: "$1.00" }],
			["balance", { amount: 42 }],
			["balance", undefined],
		];
		for (const [key, params] of cases) {
			expect(sdk.i18n.t(tables, key, params), key).toBe(
				translatePluginString(tables, "zh-CN", key, params),
			);
		}
	});

	test("a substituted value is not rescanned for placeholders", () => {
		const { sdk } = runShell({ locale: "en", localeChain: ["en"] });
		const nested = { en: { greet: "Hi {name}" } };
		expect(sdk.i18n.t(nested, "greet", { name: "{secret}", secret: "leaked" })).toBe("Hi {secret}");
	});
});

describe("shell presentation: live updates", () => {
	test("a theme push rewrites the token style in place", () => {
		// No plugin involvement: the browser recalculates from the new variable values.
		const { tokenStyle, push, head } = runShell({
			tokenCss: ":root { --nf-color-body: #fff; }",
		});
		push("host.theme", { tokenCss: ":root { --nf-color-body: #000; }" });
		expect(tokenStyle?.textContent).toContain("#000");
		// Still one element, not a second one appended per push.
		expect(head.filter((node) => node.id === TOKEN_STYLE_ELEMENT_ID).length).toBe(1);
	});

	test("a locale push updates the SDK and notifies the plugin", () => {
		// Text cannot follow automatically the way CSS does, so the hook is what makes a live
		// locale meaningful. Without it the value would read correctly while the screen did not
		// change — worse than a documented snapshot.
		const { sdk, push } = runShell({ locale: "en", localeChain: ["en"] });
		const seen: string[] = [];
		sdk.i18n.onChange((locale) => seen.push(locale));
		push("host.locale", { locale: "zh-CN", localeChain: ["zh-CN", "en"] });
		expect(sdk.i18n.locale).toBe("zh-CN");
		expect(seen).toEqual(["zh-CN"]);
		expect(sdk.i18n.t({ en: { signIn: "Sign in" }, "zh-CN": { signIn: "登录" } }, "signIn")).toBe(
			"登录",
		);
	});

	test("unsubscribing stops delivery", () => {
		const { sdk, push } = runShell({ locale: "en", localeChain: ["en"] });
		const seen: string[] = [];
		const off = sdk.i18n.onChange((locale) => seen.push(locale));
		off();
		push("host.locale", { locale: "zh-CN", localeChain: ["zh-CN", "en"] });
		expect(seen).toEqual([]);
	});

	test("one throwing listener does not stop the others", () => {
		const { sdk, push } = runShell({ locale: "en", localeChain: ["en"] });
		const seen: string[] = [];
		sdk.i18n.onChange(() => {
			throw new Error("boom");
		});
		sdk.i18n.onChange((locale) => seen.push(locale));
		push("host.locale", { locale: "zh-CN", localeChain: ["zh-CN", "en"] });
		expect(seen).toEqual(["zh-CN"]);
	});

	test("presentation pushes are not delivered as raw plugin notifications", () => {
		// They have typed channels; forwarding them too would give plugins a second, untyped way
		// to observe the same events.
		const { sdk, push } = runShell({ locale: "en", localeChain: ["en"] });
		const raw: unknown[] = [];
		sdk.onNotification((message) => raw.push(message));
		push("host.theme", { tokenCss: ":root { --nf-radius: 2px; }" });
		push("host.locale", { locale: "zh-CN", localeChain: ["zh-CN", "en"] });
		expect(raw).toEqual([]);
	});
});
