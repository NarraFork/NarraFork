import { afterEach, describe, expect, test } from "bun:test";
import { readHostTokens, renderTokenCss, TOKEN_PREFIX, TOKEN_SOURCES } from "./host-tokens";

/**
 * The token bridge, and specifically the property the whole design rests on: values are read
 * from the live document, so anything that overrides a host variable flows through.
 *
 * `getComputedStyle` is stubbed rather than driven through a real cascade because `linkedom`
 * (the DOM these tests run on) does not implement one. That is not a weakening: the assertion
 * that matters is "whatever the document resolves to is what gets emitted", and a stub states
 * the resolved values directly. `readHostTokens` accepts an element for exactly this reason.
 */

const originalGetComputedStyle = globalThis.getComputedStyle;

function withResolvedVariables(values: Record<string, string>): Element {
	const element = { nodeType: 1 } as unknown as Element;
	globalThis.getComputedStyle = ((target: Element) => {
		if (target !== element) throw new Error("unexpected element");
		return {
			getPropertyValue: (name: string) => values[name] ?? "",
		} as CSSStyleDeclaration;
	}) as typeof globalThis.getComputedStyle;
	return element;
}

afterEach(() => {
	globalThis.getComputedStyle = originalGetComputedStyle;
});

describe("host tokens: values come from the document", () => {
	test("an OLED override reaches the plugin, because the value is resolved not mapped", () => {
		// This is the regression that decided the implementation. `styles/oled.css` sets
		// `--mantine-color-body: #000000` on `<html>`; a hardcoded "dark means #1a1b1e" table
		// would report the un-overridden colour and the panel would sit a shade off the host
		// with nothing to indicate why.
		const element = withResolvedVariables({ "--mantine-color-body": "#000000" });
		expect(readHostTokens(element)["color-body"]).toBe("#000000");
	});

	test("a plugin theme override reaches the plugin the same way", () => {
		// Plugin themes are compiled to `[data-plugin-theme=…] { --mantine-*: … }` rules, i.e.
		// the same variables. Nothing token-specific is needed for them to work.
		const element = withResolvedVariables({
			"--mantine-color-text": "rgb(240, 230, 210)",
			"--mantine-primary-color-filled": "#7a5cff",
		});
		const tokens = readHostTokens(element);
		expect(tokens["color-text"]).toBe("rgb(240, 230, 210)");
		expect(tokens["color-primary"]).toBe("#7a5cff");
	});

	test("every declared token is read from the source it names", () => {
		// Guards against a token silently reading the wrong variable, which would look like a
		// theming quirk rather than a wiring mistake.
		const values: Record<string, string> = {};
		for (const source of Object.values(TOKEN_SOURCES)) values[source] = `value-for(${source})`;
		const tokens = readHostTokens(withResolvedVariables(values));
		for (const [name, source] of Object.entries(TOKEN_SOURCES)) {
			expect(tokens[name], name).toBe(`value-for(${source})`);
		}
	});

	test("an unresolved variable is omitted rather than emitted empty", () => {
		// An empty custom property still counts as *set*, so `var(--nf-x, fallback)` would
		// resolve to nothing instead of the fallback — worse for the plugin than no token at all.
		const tokens = readHostTokens(withResolvedVariables({ "--mantine-color-body": "   " }));
		expect("color-body" in tokens).toBe(false);
	});
});

describe("host tokens: the emitted CSS", () => {
	test("declares every token under the public prefix", () => {
		const css = renderTokenCss({ "color-text": "#fff", radius: "8px" });
		expect(css).toContain(`${TOKEN_PREFIX}color-text: #fff;`);
		expect(css).toContain(`${TOKEN_PREFIX}radius: 8px;`);
		expect(css.startsWith(":root {")).toBe(true);
	});

	test("an empty set produces no rule at all", () => {
		// Not `:root { }`: the shell treats an empty string as "nothing to inject" and leaves
		// plugin fallbacks intact.
		expect(renderTokenCss({})).toBe("");
	});

	test("a value that could close the declaration is dropped", () => {
		// These values come from the host's own computed style and structurally cannot contain
		// these characters, so this is defence in depth — but the failure it prevents is CSS
		// injection into every plugin panel, which is worth one regex.
		const css = renderTokenCss({
			"color-text": "#fff; } :root { --nf-color-body: red",
			"color-body": "#111",
		});
		expect(css).not.toContain("red");
		expect(css).toContain(`${TOKEN_PREFIX}color-body: #111;`);
	});

	test("a comment sequence is dropped", () => {
		expect(renderTokenCss({ "color-text": "#fff /* x" })).toBe("");
	});

	test("an unreasonably long value is dropped", () => {
		expect(renderTokenCss({ "color-text": "a".repeat(513) })).toBe("");
	});

	/**
	 * `url()` is rejected for a different reason than the characters above.
	 *
	 * Those are structural: they could end the declaration. This one is about effect — a
	 * token lands in the plugin iframe's `:root`, so a `url(...)` in one becomes a fetch
	 * performed by a document whose CSP is written for a panel that loads only its own
	 * assets (`default-src 'none'`, `connect-src 'none'`, `img-src` allowing `data:` and
	 * `blob:`). No current token contains one; the guard is here so a future Mantine
	 * version expressing a surface as an inline SVG cannot quietly grant that.
	 */
	test("a url() value is dropped, in every spelling", () => {
		for (const value of [
			"url(https://evil.example/x.png)",
			"URL(https://evil.example/x.png)",
			"url ( https://evil.example/x.png )",
			"center / cover no-repeat url('/x.svg')",
			'url("data:image/svg+xml,<svg/>")',
		]) {
			expect(renderTokenCss({ "color-body": value })).toBe("");
		}
	});

	test("still keeps legitimate values that merely contain the letters 'url'", () => {
		// The guard matches `url` followed by `(` at a word boundary, not the substring: a
		// font family called `Urlaub` or a keyword ending in `url` must survive, because a
		// dropped token is silent and shows up only as a panel that looks slightly wrong.
		const css = renderTokenCss({ font: '"Urlaub Grotesk", sans-serif' });
		expect(css).toContain("Urlaub Grotesk");
	});

	test("keeps the CSS functions Mantine actually emits", () => {
		// The rejection must be specific to `url(`, not to functional notation: colours
		// legitimately arrive as `rgba()`, `color-mix()` and `calc()`.
		const css = renderTokenCss({
			"color-body": "rgba(17, 17, 17, 0.85)",
			"color-primary": "color-mix(in srgb, #4c6ef5 60%, white)",
			spacing: "calc(1rem * 1.5)",
		});
		expect(css).toContain("rgba(17, 17, 17, 0.85)");
		expect(css).toContain("color-mix(in srgb, #4c6ef5 60%, white)");
		expect(css).toContain("calc(1rem * 1.5)");
	});
});
