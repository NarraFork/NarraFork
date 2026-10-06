/**
 * The design tokens the host hands to plugin iframes, and how their values are obtained.
 *
 * ## Why plugins need this at all
 *
 * A plugin panel is a separate document with `connect-src 'none'` and no access to the host's
 * React or Mantine. Before this existed, the only way to style one was to hardcode colours —
 * which every panel did, each with its own palette. The result was that switching the host
 * theme, enabling OLED, or activating a plugin-contributed theme changed everything except the
 * plugin panels.
 *
 * ## Values are READ FROM THE LIVE DOCUMENT, never mapped from a table
 *
 * This is the one decision the whole feature rests on. OLED (`styles/oled.css`) and
 * plugin-contributed themes (`lib/plugins/theme-compiler.ts`) both work by *overwriting the
 * same `--mantine-*` variables* on `<html>`:
 *
 *     :root[data-mantine-color-scheme="dark"][data-oled="true"] {
 *       --mantine-color-body: #000000;
 *     }
 *
 * So reading the computed value picks both up for free, while a hardcoded
 * "dark means #1a1b1e" table would silently miss them and reintroduce exactly the problem this
 * set out to fix. The failure would not look like a bug either — the colours would merely be
 * a shade off, which nobody reports.
 *
 * ## The set is deliberately small
 *
 * Fourteen semantic names, not the whole Mantine variable surface. Every name here becomes a
 * public contract that plugins may reference forever, so exporting the host's internals would
 * make any Mantine-level refactor a breaking change for third-party plugins. The narrow
 * vocabulary is the same bargain `theme-compiler.ts` strikes in the other direction, where
 * plugins may supply whitelisted tokens but never raw CSS.
 */

/** Prefix for every token this module emits. Part of the public contract. */
export const TOKEN_PREFIX = "--nf-";

/** The `<style>` element the shell creates inside the iframe to hold these declarations. */
export const TOKEN_STYLE_ELEMENT_ID = "nf-tokens";

/**
 * Public token name → the host variable it is read from.
 *
 * Order is irrelevant to correctness but kept stable so the emitted CSS diffs cleanly when
 * inspected. Every source name was verified against actual usage in the host stylesheets
 * rather than assumed from Mantine's docs: a variable that does not exist resolves to an empty
 * string, and an empty custom property is not a visible failure — the plugin just falls back to
 * whatever the browser default is, and looks slightly wrong for reasons nobody can see.
 */
export const TOKEN_SOURCES: Readonly<Record<string, string>> = {
	// Surfaces and text.
	"color-body": "--mantine-color-body",
	"color-text": "--mantine-color-text",
	"color-dimmed": "--mantine-color-dimmed",
	"color-surface": "--mantine-color-default",
	"color-border": "--mantine-color-default-border",
	// Primary action.
	"color-primary": "--mantine-primary-color-filled",
	"color-primary-hover": "--mantine-primary-color-filled-hover",
	// Semantic states. The `-text` variants are used rather than the raw palette shades
	// because they are the ones Mantine keeps legible against the body background in both
	// schemes; a raw `red-6` on a light theme is not.
	"color-error": "--mantine-color-red-text",
	"color-success": "--mantine-color-green-text",
	"color-warning": "--mantine-color-yellow-text",
	// Typography.
	font: "--mantine-font-family",
	"font-mono": "--mantine-font-family-monospace",
	// Box model. One rung each: a plugin panel is a simple form, and exporting a full
	// xs..xl ladder would triple the contract surface for no expressiveness a panel needs.
	radius: "--mantine-radius-md",
	spacing: "--mantine-spacing-md",
} as const;

/** A resolved token set, keyed by public name without the prefix. */
export type HostTokens = Readonly<Record<string, string>>;

/**
 * Read the current token values off an element's computed style.
 *
 * `element` defaults to `<html>`, which is where every override lands. Passing one explicitly
 * is what makes this testable without a full app render.
 *
 * Empty values are dropped rather than emitted as `--nf-x: ;`: an empty custom property still
 * counts as *set*, so it would defeat the plugin's own `var(--nf-x, fallback)` and leave it
 * with nothing at all. Omitting the declaration lets the fallback work.
 */
export function readHostTokens(element?: Element): HostTokens {
	// Guards on what is actually used, not on `window`: an explicit element needs only
	// `getComputedStyle`, and requiring a full window would make this untestable outside a
	// browser while adding no safety.
	if (typeof getComputedStyle !== "function") return {};
	const target =
		element ?? (typeof document === "undefined" ? undefined : document.documentElement);
	if (!target) return {};
	const computed = getComputedStyle(target);
	const tokens: Record<string, string> = {};
	for (const [name, source] of Object.entries(TOKEN_SOURCES)) {
		const value = computed.getPropertyValue(source).trim();
		if (value) tokens[name] = value;
	}
	return tokens;
}

/**
 * Render a token set as the body of the iframe's `<style>` element.
 *
 * Values are filtered, not escaped-and-trusted: they land inside a stylesheet in another
 * document, so a value carrying `;` or `}` could close the declaration and inject arbitrary
 * rules. These values come from the host's own computed style — already parsed by the browser,
 * so structurally they cannot contain those characters — but the guard stays because the cost
 * is one regex and the failure mode is CSS injection into every plugin panel.
 */
export function renderTokenCss(tokens: HostTokens): string {
	const declarations: string[] = [];
	for (const [name, value] of Object.entries(tokens)) {
		if (!isSafeTokenName(name) || !isSafeTokenValue(value)) continue;
		declarations.push(`\t${TOKEN_PREFIX}${name}: ${value};`);
	}
	if (declarations.length === 0) return "";
	return `:root {\n${declarations.join("\n")}\n}\n`;
}

/** Token names are ours, so this only has to reject anything that is not one of ours. */
function isSafeTokenName(name: string): boolean {
	return /^[a-z0-9-]+$/.test(name);
}

/**
 * Whether a value can be placed in a declaration verbatim.
 *
 * Rejects the characters that would end the declaration or the rule, plus the comment opener
 * and anything non-printable. Deliberately a denylist of structural characters rather than an
 * allowlist of value syntax: colours arrive in many forms (`#fff`, `rgb()`, `color-mix()`,
 * font stacks with quotes), and an allowlist tight enough to be safe would reject legitimate
 * values from a future Mantine version — which, being a silent drop, nobody would notice.
 */
function isSafeTokenValue(value: string): boolean {
	if (value.length === 0 || value.length > 512) return false;
	if (/[;{}<>\\]/.test(value)) return false;
	if (value.includes("/*") || value.includes("*/")) return false;
	// `url()` is refused even though it cannot end a declaration.
	//
	// The other rejections above are about structure; this one is about EFFECT. A token
	// value reaches the plugin iframe's `:root`, so a `url(...)` inside one becomes a
	// fetch performed by that document — and the iframe's CSP is written for a panel that
	// only loads its own assets (`default-src 'none'`, `connect-src 'none'`), with
	// `img-src` deliberately allowing `data:` and `blob:`. A host variable is not a
	// plausible attack vector today (all 14 are colours, font stacks and lengths, already
	// parsed by the browser), but "a host theme variable turns into a request from inside
	// the sandbox" is not a property worth acquiring by accident on some future Mantine
	// version that expresses a surface as an inline SVG.
	//
	// Costs nothing real: no legitimate token in TOKEN_SOURCES contains `url(`, and a
	// rejected token falls back to the plugin's own `var(--nf-x, fallback)`.
	if (/\burl\s*\(/i.test(value)) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	return !/[\u0000-\u001f\u007f]/.test(value);
}
