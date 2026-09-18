import { describe, expect, test } from "bun:test";
import { DEFAULT_THEME, getCSSColorVariables } from "@mantine/core";
import {
	getEffectiveNarratorDisplay,
	type NarratorStatus,
	statusAccentColor,
	statusAccentVar,
} from "./status-registry";

/**
 * The attention palette is a product contract, not a style detail: orange/yellow
 * means "a person has to do something". A narrator parked until an unavailable
 * model recovers is also reported as `waiting`, so without a dedicated entry it
 * silently inherits the attention color and the user can no longer tell the two
 * apart. These tests pin that separation.
 */
describe("model_unavailable is not an attention color", () => {
	test("waiting for a model resolves to the blue-toned neutral, not yellow", () => {
		const display = getEffectiveNarratorDisplay("waiting", ["model_unavailable"]);
		expect(display.color).toBe("slate");
		expect(display.i18nKey).toBe("status.narratorModelUnavailable");
	});

	test("plain waiting (needs approval) keeps the attention color", () => {
		expect(getEffectiveNarratorDisplay("waiting", []).color).toBe("yellow");
	});

	test("no attention state shares a hue with waiting-for-model", () => {
		const attentionStates = [
			getEffectiveNarratorDisplay("waiting", []),
			getEffectiveNarratorDisplay("idle", ["manual_override"]),
			getEffectiveNarratorDisplay("idle", ["interrupted"]),
			getEffectiveNarratorDisplay("idle", ["error"]),
		];
		const waitingForModel = getEffectiveNarratorDisplay("waiting", ["model_unavailable"]);
		for (const state of attentionStates) {
			expect(state.color).not.toBe(waitingForModel.color);
		}
	});
});

describe("substatus priority around model_unavailable", () => {
	test("a concrete failure outranks it", () => {
		expect(getEffectiveNarratorDisplay("waiting", ["model_unavailable", "error"]).color).toBe(
			"red",
		);
		expect(getEffectiveNarratorDisplay("waiting", ["model_unavailable", "retrying"]).i18nKey).toBe(
			"status.narratorRetrying",
		);
	});

	test("it outranks secondary bookkeeping tags", () => {
		// The turn is blocked on the model; a queued/compacting tag alongside it is
		// not what the user should be told.
		for (const secondary of ["compacting", "background_compacting", "queued", "unread"]) {
			expect(getEffectiveNarratorDisplay("waiting", [secondary, "model_unavailable"]).i18nKey).toBe(
				"status.narratorModelUnavailable",
			);
		}
	});
});

/**
 * An exhausted quota window is the same situation as an unavailable model — the
 * MACHINE is waiting, nothing is actionable — so it reuses the palette and the
 * priority slot but must keep its own LABEL. One shared entry would render both
 * causes as "waiting for model", which is wrong about what is being waited for.
 */
describe("quota_exhausted is a labelled sibling of model_unavailable", () => {
	test("it names its own state", () => {
		const display = getEffectiveNarratorDisplay("waiting", ["quota_exhausted"]);
		expect(display.i18nKey).toBe("status.narratorQuotaExhausted");
		expect(display.i18nKey).not.toBe(
			getEffectiveNarratorDisplay("waiting", ["model_unavailable"]).i18nKey,
		);
	});

	test("it reads as the same kind of wait (neutral, filled, no alert shape)", () => {
		const display = getEffectiveNarratorDisplay("waiting", ["quota_exhausted"]);
		const modelUnavailable = getEffectiveNarratorDisplay("waiting", ["model_unavailable"]);
		expect(display.color).toBe(modelUnavailable.color);
		expect(display.accentShade).toBe(modelUnavailable.accentShade);
		expect(display.solidAccent).toBe(true);
		expect(display.shape).toBeUndefined();
		expect(display.color).not.toBe("yellow");
	});

	test("failures outrank it and secondary tags do not", () => {
		expect(getEffectiveNarratorDisplay("waiting", ["quota_exhausted", "error"]).color).toBe("red");
		expect(getEffectiveNarratorDisplay("waiting", ["quota_exhausted", "retrying"]).i18nKey).toBe(
			"status.narratorRetrying",
		);
		for (const secondary of ["compacting", "background_compacting", "queued", "unread"]) {
			expect(getEffectiveNarratorDisplay("waiting", [secondary, "quota_exhausted"]).i18nKey).toBe(
				"status.narratorQuotaExhausted",
			);
		}
	});

	test("a model outage named alongside it wins, so the two can never disagree", () => {
		// Both tags are written by the same suspension, so seeing them together means a
		// stale tag survived; the outage is the earlier condition and stays on top.
		expect(
			getEffectiveNarratorDisplay("waiting", ["model_unavailable", "quota_exhausted"]).i18nKey,
		).toBe("status.narratorModelUnavailable");
	});
});

describe("accent helpers", () => {
	test("a pinned accent shade produces Mantine shade shorthand", () => {
		const display = getEffectiveNarratorDisplay("waiting", ["model_unavailable"]);
		// slate's default filled step is near-background in dark mode, so the entry
		// pins a legible one instead of relying on the theme default.
		expect(display.accentShade).toBe(5);
		expect(statusAccentColor(display)).toBe("slate.5");
		expect(statusAccentVar(display, "filled")).toBe("var(--mantine-color-slate-5)");
	});

	test("entries without a pinned shade keep the call site default", () => {
		const display = getEffectiveNarratorDisplay("waiting", []);
		expect(statusAccentColor(display)).toBe("yellow");
		expect(statusAccentVar(display, "filled")).toBe("var(--mantine-color-yellow-filled)");
		expect(statusAccentVar(display, 6)).toBe("var(--mantine-color-yellow-6)");
	});
});

/**
 * Waiting-for-model must be distinguishable from *idle*, not just from the
 * attention states. The first attempt failed in production precisely here: a
 * Tailwind-slate light step is ~20% saturated, which next to idle's flat gray
 * reads as the same color — and on surfaces that draw idle as a hollow glyph, an
 * equally hollow blue-gray glyph is indistinguishable no matter the hue.
 *
 * These assertions pin both halves of that fix: enough blue to separate from
 * idle without impersonating an actively working narrator, plus the solid-glyph
 * flag that surfaces use for their idle-vs-occupied signal.
 */
describe("waiting-for-model is distinguishable from idle", () => {
	const IDLE_GRAY = "#868e96"; // gray-6, the sidebar's idle icon color
	const WORKING_BLUE = "#228be6"; // blue-6, an actively working narrator

	/** Saturation as a percentage — how far the color is from plain gray. */
	function saturation(hex: string): number {
		const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		return max === 0 ? 0 : ((max - min) / max) * 100;
	}

	const theme = {
		...DEFAULT_THEME,
		colors: {
			...DEFAULT_THEME.colors,
			slate: [
				"#f2f5f9",
				"#e4e9f2",
				"#c7d2e3",
				"#a9b9d3",
				"#93a8c8",
				"#7d95b8",
				"#6a83a8",
				"#556c8e",
				"#425572",
				"#314056",
			] as unknown as (typeof DEFAULT_THEME.colors)["gray"],
		},
	};

	/** The actual color the accent shade resolves to, via Mantine's own resolver. */
	function accentHex(): string {
		const display = getEffectiveNarratorDisplay("waiting", ["model_unavailable"]);
		const vars = getCSSColorVariables({ theme, color: "slate", colorScheme: "dark" });
		const resolved = vars[`--mantine-color-slate-${display.accentShade}`];
		expect(resolved).toMatch(/^#[0-9a-f]{6}$/i);
		return resolved as string;
	}

	test("the accent is clearly more saturated than idle gray", () => {
		// Idle gray sits at ~11%. The earlier Tailwind-slate step was ~20%, which
		// was not enough separation in practice.
		expect(saturation(accentHex())).toBeGreaterThan(saturation(IDLE_GRAY) * 2.5);
	});

	test("the accent stays far less saturated than an actively working narrator", () => {
		expect(saturation(accentHex())).toBeLessThan(saturation(WORKING_BLUE) / 2);
	});

	test("it renders as a solid glyph, since hollow reads as idle", () => {
		const display = getEffectiveNarratorDisplay("waiting", ["model_unavailable"]);
		expect(display.solidAccent).toBe(true);
	});

	test("genuinely idle carries no solid-accent flag", () => {
		expect(getEffectiveNarratorDisplay("idle", []).solidAccent).toBeUndefined();
	});
});

/**
 * The accent strings (`slate.5`, `var(--mantine-color-slate-5)`) and the Pixi
 * ruler layer (which reads the variable off the document) only work because
 * Mantine emits per-shade variables for a *custom* theme color, not just the
 * built-in palette. Assert that contract so a Mantine upgrade that changed it
 * would fail here instead of silently rendering invisible dots.
 */
describe("slate is a usable custom theme color", () => {
	const theme = {
		...DEFAULT_THEME,
		colors: {
			...DEFAULT_THEME.colors,
			slate: [
				"#f2f5f9",
				"#e4e9f2",
				"#c7d2e3",
				"#a9b9d3",
				"#93a8c8",
				"#7d95b8",
				"#6a83a8",
				"#556c8e",
				"#425572",
				"#314056",
			] as unknown as (typeof DEFAULT_THEME.colors)["gray"],
		},
	};

	for (const colorScheme of ["dark", "light"] as const) {
		test(`${colorScheme}: the pinned accent shade resolves to a real color`, () => {
			const vars = getCSSColorVariables({ theme, color: "slate", colorScheme });
			expect(vars["--mantine-color-slate-5"]).toBe("#7d95b8");
		});
	}

	test("the default filled step is a dark shade the accentShade pin avoids", () => {
		// Mantine's dark primaryShade is 8, so `-filled` lands on slate-8 —
		// indistinguishable from a dark card. This is why the entry pins a shade.
		const vars = getCSSColorVariables({ theme, color: "slate", colorScheme: "dark" });
		expect(vars["--mantine-color-slate-filled"]).toBe("var(--mantine-color-slate-8)");
		expect(vars["--mantine-color-slate-8"]).toBe("#425572");
	});
});

/**
 * A reflecting narrator is OCCUPIED, and every surface has to say so.
 *
 * The failure this pins: a reflection gate parks its narrator at `waiting`
 * (narrator-permission.ts), which is not one of the statuses the sidebar's fill rule
 * enumerates — so the tab icon rendered HOLLOW, the exact shape idle uses. The gate had
 * paused the session on a decision that might come back to the user, and the sidebar
 * showed nothing was happening. Colour could not fix it: hollow-teal still reads as
 * idle (see `solidAccent`'s doc).
 *
 * Also pinned: reflecting and reasoning must not share a hue. Both mean "the model is
 * thinking", but reasoning is ordinary progress while a gate is a PAUSE — and they
 * appeared as the same grape dot.
 */
describe("a reflecting narrator reads as occupied, and not as reasoning", () => {
	test("reflecting owns a solid accent so the sidebar fills its glyph", () => {
		// `waiting` is what the gate actually sets, which is why the flag has to live on
		// the substatus rather than relying on the base status.
		expect(getEffectiveNarratorDisplay("waiting", ["reflecting"]).solidAccent).toBe(true);
	});

	test("reflecting joins the attention family by COLOUR", () => {
		// The gate is interactive — approve / reject / take over — so it shares the orange
		// of the other states the user can act on. Identity comes from shape, not hue.
		expect(getEffectiveNarratorDisplay("waiting", ["reflecting"]).color).toBe("orange");
	});

	test("reflecting is told apart from reasoning by SHAPE, not colour", () => {
		// The distinction that colour could no longer carry. Both mean "the model is
		// thinking", but reasoning is ordinary progress while a gate has PAUSED the session
		// on something the reader may answer.
		const reflecting = getEffectiveNarratorDisplay("waiting", ["reflecting"]);
		const reasoning = getEffectiveNarratorDisplay("working", ["reasoning"]);
		expect(reflecting.shape).toBe("shield");
		expect(reasoning.shape).toBeUndefined();
	});

	test("the favicon dot matches the registry's reflecting hue", async () => {
		// The favicon is the one surface that hard-codes hex instead of reading a CSS
		// variable, so the two can silently drift — a stale dot is exactly the kind of
		// mismatch nothing else would catch. Shade 6 is the step the other alert dots use.
		const entry = getEffectiveNarratorDisplay("waiting", ["reflecting"]);
		const expected = DEFAULT_THEME.colors[entry.color as "orange"][6];
		const source = await Bun.file(new URL("./favicon.ts", import.meta.url)).text();
		const dot = /reflecting:\s*"(#[0-9a-fA-F]{6})"/.exec(source)?.[1];
		expect(dot?.toLowerCase()).toBe(String(expected).toLowerCase());
	});
});

/**
 * The shape vocabulary exists because the palette ran out of usable hues (teal measured
 * 31° from green, cyan 21° from blue, and so on). These pin the mapping that replaced
 * "one state, one colour", so a future colour tweak cannot quietly collapse two states
 * back into looking alike.
 */
describe("status shapes separate states colour no longer can", () => {
	test("the three shapes are assigned to the states that need them", () => {
		// A finished result, a gate the reader may enter, and a hard block on the reader.
		expect(getEffectiveNarratorDisplay("idle", ["unread"]).shape).toBe("check");
		expect(getEffectiveNarratorDisplay("waiting", ["reflecting"]).shape).toBe("shield");
		expect(getEffectiveNarratorDisplay("waiting").shape).toBe("alert");
	});

	test("states the user cannot act on carry NO shape", () => {
		// `retrying` / `queued` / `model_unavailable` / `quota_exhausted` are all
		// waiting-ish, but on the MACHINE. Drawing an alert on them would cry for
		// attention that cannot be given — the same reasoning that already excludes
		// them from the favicon and notifications.
		for (const tag of ["retrying", "queued", "model_unavailable", "quota_exhausted"]) {
			expect(getEffectiveNarratorDisplay("waiting", [tag]).shape).toBeUndefined();
		}
		expect(getEffectiveNarratorDisplay("working").shape).toBeUndefined();
		expect(getEffectiveNarratorDisplay("idle").shape).toBeUndefined();
	});

	test("the sidebar derives its shape from the registry", async () => {
		// Same contract as `isFilledRecentTabStatus`: derived, not re-enumerated, so a
		// state that gains a shape tomorrow is picked up without touching this component.
		const source = await Bun.file(
			new URL("../components/nav/RecentTabs.tsx", import.meta.url),
		).text();
		const body = source.slice(
			source.indexOf("function getRecentTabShape"),
			source.indexOf("const SHAPE_MARKERS"),
		);
		expect(body).toContain("getEffectiveNarratorDisplay");
		expect(body).toContain(".shape");
	});

	/**
	 * Guards the size floor. Two attempts landed on an illegible glyph by different routes:
	 * first a 7px corner badge, then a glyph scaled to sit "inside" the icon at ~58%, which
	 * on a 14px host is 8px — the same problem again. The hosts render at 14–16px, so the
	 * ratio has to be generous or the shape cannot be read at all.
	 */
	test("the knocked-out glyph is big enough to identify", async () => {
		const source = await Bun.file(
			new URL("../components/nav/RecentTabs.tsx", import.meta.url),
		).text();
		const ratio = source.match(/const SHAPE_GLYPH_RATIO = ([\d.]+)/);
		expect(ratio).not.toBeNull();
		// At both sizes actually used, clear the 7px badge that started this.
		for (const host of [14, 16]) {
			expect(Math.round(host * Number(ratio?.[1]))).toBeGreaterThan(8);
		}
	});

	/**
	 * The glyph is white and has NO body of its own — it is knocked out of the host bubble's
	 * fill. Two consequences this pins down, both of which were shipped wrong once:
	 *
	 *  - It must not paint a disc. A full-size circle buried the bubble and spilled past its
	 *    ink, reading as a blob stuck on the tab.
	 *  - It must only render where a solid body exists. The chapter and subagent icons are
	 *    Tabler outline glyphs, so a white shape over them would vanish into the page.
	 */
	test("the shape is knocked out of the bubble rather than painted over it", async () => {
		const source = await Bun.file(
			new URL("../components/nav/RecentTabs.tsx", import.meta.url),
		).text();
		// Both delimiters are asserted to EXIST before slicing. `indexOf` returns -1 for a
		// missing needle, and `slice(start, -1)` silently yields a near-empty or reversed
		// range — which would make the three `not.toContain` checks below pass on nothing.
		// (`isTabActive` used to be the end delimiter and has since moved to
		// `recent-tabs-logic.ts`, which is exactly how this trap gets sprung.)
		const start = source.indexOf("function ShapeOverlay");
		const end = source.indexOf("function WorkspaceChildTab");
		expect(start).toBeGreaterThan(-1);
		expect(end).toBeGreaterThan(start);
		const overlay = source.slice(start, end);
		expect(overlay).toContain('color: "var(--mantine-color-white)"');
		// No body of its own: no background fill and no circle to align.
		expect(overlay).not.toContain("background:");
		expect(overlay).not.toContain("borderRadius");
		// The whole icon is one click target; the glyph must not become a dead spot.
		expect(overlay).toContain('pointerEvents: "none"');
		// And it is gated to the one host that is genuinely filled.
		expect(source).toContain('const canShowShape = tab.type === "narrator" && filledStatus');
	});

	/**
	 * Any state carrying a shape must also fill its bubble. This is the invariant that keeps
	 * the knockout visible: a white glyph on a hollow outline is invisible, so `shape`
	 * without `filled` would silently render nothing.
	 */
	test("every state with a shape also fills, so the knockout has a body", () => {
		const shaped: Array<[NarratorStatus, string[] | undefined]> = [
			["idle", ["unread"]],
			["waiting", ["reflecting"]],
			["waiting", undefined],
		];
		for (const [status, substatus] of shaped) {
			const display = getEffectiveNarratorDisplay(status, substatus);
			expect(display.shape).toBeDefined();
			expect(isFilledForShape(display)).toBe(true);
		}
	});
});

/** Mirrors the sidebar's fill rule: a shape implies a filled host. */
function isFilledForShape(display: { solidAccent?: boolean; shape?: string }): boolean {
	return !!display.solidAccent || !!display.shape;
}

/**
 * The Pixi ruler layer needs a numeric hex read off a CSS variable, so it cannot use
 * the registry's Mantine props — but it must not re-spell the shade either. That
 * duplicate is what shipped a stale shade in the first release of this feature, with
 * nothing failing: the ruler dots were simply the wrong colour.
 *
 * ⚠️ This used to be asserted by REGEX-MATCHING pixi-theme's source for the literal
 * `"--mantine-color-slate-5"`. That is a snapshot of an implementation detail: it
 * broke on any reformatting and, worse, it passed for two files that agreed on a
 * WRONG shade. The bridge now DERIVES the variable name from the registry, so the
 * duplicate is gone and the test can assert the real thing — the value both sides
 * resolve to.
 */
describe("the Pixi theme bridge tracks the registry accent shade", () => {
	test("pixi-theme derives its variable name from the registry entry", async () => {
		const display = getEffectiveNarratorDisplay("waiting", ["model_unavailable"]);
		const { PIXI_THEME_VARS } = await import("../components/ruler/pixi/pixi-theme");
		// The exact variable the registry pins for this state — not a shade spelled
		// twice, but one derivation observed from both sides.
		expect(PIXI_THEME_VARS.narratorModelUnavailable).toBe(
			`--mantine-color-${display.color}-${display.accentShade}`,
		);
	});
});

/**
 * The sidebar is where "indistinguishable from idle" was actually reported: it
 * draws idle as a hollow glyph and busy as a filled one, so color alone cannot
 * carry the difference. Its fill decision is a module-private helper, so assert
 * that it consults `solidAccent` rather than only listing statuses by hand.
 *
 * ⚠️ Deliberately still a SOURCE assertion, unlike the pixi bridge above. What is
 * being pinned here is not a value two files must agree on — it is that the decision
 * is DERIVED from the registry rather than re-enumerated by hand. A behavioural test
 * cannot see that difference: a hardcoded `status === "waiting" && …` list would
 * return the same booleans today and silently stop tracking any state added to the
 * registry tomorrow, which is exactly the regression this guards. Exporting the
 * helper to test it directly would still not distinguish the two implementations.
 */
describe("the sidebar fill decision consults solidAccent", () => {
	test("isFilledRecentTabStatus reads the registry flag", async () => {
		const source = await Bun.file(
			new URL("../components/nav/RecentTabs.tsx", import.meta.url),
		).text();
		const body = source.slice(
			source.indexOf("function isFilledRecentTabStatus"),
			source.indexOf("const CONTAINER_STATUS_I18N"),
		);
		expect(body).toContain("solidAccent");
		expect(body).toContain("getEffectiveNarratorDisplay");
	});
});
