/**
 * The colours of the task state badges (`outline-icons.css`): every state has tokens for both
 * schemes, and its icon keeps a graphical contrast of 3:1 or more against its own tinted
 * background over the page, computed from the stylesheet's own lines and Mantine's palette.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_THEME } from "@mantine/core";
import { OUTLINE_STATUS_KEYS, OUTLINE_STATUS_TONE } from "@shared/outline-status";

const css = readFileSync(new URL("./outline-icons.css", import.meta.url), "utf8");

type Scheme = "light" | "dark";
interface Tokens {
	fg: string;
	bg: string;
}

/** `--nf-status-fg` / `--nf-status-bg` of a state's rule in a scheme, as `colour-shade`. */
function tokensOf(status: string, scheme: Scheme): Tokens | null {
	const prefix = scheme === "dark" ? '\\[data-mantine-color-scheme="dark"\\] ' : "(?<!\\] )";
	const rule = new RegExp(
		`${prefix}\\.nf-status\\[data-status="${status}"\\] \\{([^}]*)\\}`,
		"m",
	).exec(css);
	if (!rule) return null;
	const token = (name: string) =>
		new RegExp(`--nf-status-${name}: var\\(--mantine-color-([a-z]+-\\d)\\);`).exec(
			rule[1] as string,
		)?.[1] ?? null;
	const fg = token("fg");
	const bg = token("bg");
	return fg && bg ? { fg, bg } : null;
}

function tintOf(scheme: Scheme): number {
	const rule =
		scheme === "dark"
			? /\[data-mantine-color-scheme="dark"\] \.nf-status \{([^}]*)\}/.exec(css)
			: /^\.nf-status \{([^}]*)\}/m.exec(css);
	const percent = /--nf-status-tint: (\d+)%/.exec(rule?.[1] ?? "")?.[1];
	if (!percent) throw new Error(`no tint for ${scheme}`);
	return Number(percent) / 100;
}

type Rgb = [number, number, number];

function rgb(hex: string): Rgb {
	const n = Number.parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function palette(name: string): Rgb {
	const [colour, shade] = name.split("-") as [string, string];
	const hex = DEFAULT_THEME.colors[colour]?.[Number(shade)];
	if (!hex) throw new Error(`unknown colour ${name}`);
	return rgb(hex);
}

function luminance([r, g, b]: Rgb): number {
	const channel = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
}

const mix = (over: Rgb, under: Rgb, alpha: number): Rgb =>
	over.map((v, i) => Math.round(v * alpha + (under[i] as number) * (1 - alpha))) as Rgb;

/** What the badge sits on: the page, and a card or hovered row a little off it. */
const SURFACES: Record<Scheme, Rgb[]> = {
	light: [rgb("#ffffff"), rgb(DEFAULT_THEME.colors.gray[1] as string)],
	dark: [rgb(DEFAULT_THEME.colors.dark[7] as string), rgb(DEFAULT_THEME.colors.dark[6] as string)],
};

describe("task state badges: colours", () => {
	test("every state has its tokens in both schemes, in its own colour", () => {
		for (const status of OUTLINE_STATUS_KEYS) {
			for (const scheme of ["light", "dark"] as const) {
				const tokens = tokensOf(status, scheme);
				expect(tokens, `${status} in ${scheme}`).not.toBeNull();
				// The colour named for the state (`shared/outline-status.ts`), background and icon.
				// Cancelled alone has a ground of another colour (red-tinted), so it never looks
				// like to do, which shares its gray.
				expect(tokens?.bg.split("-")[0], `${status} ${scheme} background`).toBe(
					status === "cancelled" ? "red" : OUTLINE_STATUS_TONE[status],
				);
				expect(tokens?.fg.split("-")[0], `${status} ${scheme} icon`).toBe(
					OUTLINE_STATUS_TONE[status],
				);
			}
		}
	});

	test("an icon keeps 3:1 or more against its own background, on the page and on a card", () => {
		const low: string[] = [];
		for (const status of OUTLINE_STATUS_KEYS) {
			for (const scheme of ["light", "dark"] as const) {
				const tokens = tokensOf(status, scheme) as Tokens;
				for (const surface of SURFACES[scheme]) {
					const background = mix(palette(tokens.bg), surface, tintOf(scheme));
					const ratio = contrast(palette(tokens.fg), background);
					if (ratio < 3) low.push(`${status} ${scheme}: ${ratio.toFixed(2)}`);
				}
			}
		}
		expect(low).toEqual([]);
	});

	test("to do and cancelled, both gray icons, do not share a background", () => {
		for (const scheme of ["light", "dark"] as const) {
			const surface = SURFACES[scheme][0] as Rgb;
			const ground = (status: string) =>
				mix(palette((tokensOf(status, scheme) as Tokens).bg), surface, tintOf(scheme));
			expect(ground("cancelled"), scheme).not.toEqual(ground("todo"));
		}
	});

	test("the badge is seen against the page: its tint is not the page's own colour", () => {
		for (const scheme of ["light", "dark"] as const) {
			for (const status of OUTLINE_STATUS_KEYS) {
				const tokens = tokensOf(status, scheme) as Tokens;
				const surface = SURFACES[scheme][0] as Rgb;
				const background = mix(palette(tokens.bg), surface, tintOf(scheme));
				expect(contrast(background, surface), `${status} ${scheme}`).toBeGreaterThan(1.1);
			}
		}
	});
});
