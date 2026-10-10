/**
 * The host's Mantine theme, extracted so more than one entry point can use it.
 *
 * It used to live inline in `main.tsx`, which was fine while the app shell was the only
 * `MantineProvider`. The plugin UI runtime (`frontend/plugin-runtime/vendor.ts`) is a second
 * one: it runs inside a sandboxed iframe that cannot reach the host's React instance, so it
 * ships its own provider. Importing the same object is what keeps a plugin panel visually
 * identical to the host instead of drifting against a hand-copied set of tokens.
 */

import { createTheme } from "@mantine/core";

export const mantineTheme = createTheme({
	primaryColor: "indigo",
	defaultRadius: "sm",
	colors: {
		/*
		 * Blue-toned neutral for "the system is waiting on itself" states — e.g. a
		 * narrator parked until an unavailable model recovers. Orange/yellow is
		 * reserved for states that genuinely need the user's attention, so those
		 * two must never share a hue.
		 *
		 * The palette is deliberately tuned between two neighbours it must not be
		 * confused with, at the `-5` step used for status accents:
		 *   idle    gray-6  #868e96 — 11% saturation (flat neutral)
		 *   this    slate-5 #7d95b8 — 32% saturation (clearly blue-leaning)
		 *   working blue-6  #228be6 — 85% saturation (unmistakably "active")
		 * An earlier attempt used Tailwind slate, whose light steps sit at ~20%
		 * saturation and read as plain gray next to idle. Keep enough blue here to
		 * separate from idle without impersonating an actively working narrator.
		 *
		 * Note on shades: Mantine's dark `primaryShade` is 8, so
		 * `--mantine-color-slate-filled` resolves to the darkest steps, too dark to
		 * read as a dot or badge on a dark surface. Consumers pick an explicit
		 * light step via the registry's `accentShade`.
		 */
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
		],
	},
	components: {
		NavLink: {
			styles: {
				root: {
					borderTopLeftRadius: "var(--mantine-radius-sm)",
					borderTopRightRadius: "var(--mantine-radius-sm)",
					borderBottomLeftRadius: "var(--mantine-radius-sm)",
					borderBottomRightRadius: "var(--mantine-radius-sm)",
				},
			},
		},
		/*
		 * `nf-overlay-layer` marks every floating layer that can paint over the WCO
		 * drag surface (the header row, or the standalone window strip). app-region
		 * hit-testing is purely geometric: an overlay painted above a drag rect still
		 * has its clicks consumed as a window drag unless its own rect is subtracted
		 * with `no-drag`. Mantine v9 emits no stable component classes, so the hook
		 * is injected from here; the matching rule lives in styles/wco.css.
		 *
		 * Modal/Drawer mark the root (its overlay covers the whole viewport, so while
		 * one is open nothing can drag anyway — clicking the dimmed strip must reach
		 * the overlay's click-to-dismiss); menus/popovers mark just the dropdown.
		 */
		Modal: {
			classNames: {
				root: "nf-overlay-layer nf-modal-layer",
				inner: "nf-modal-inner",
				content: "nf-modal-content",
			},
		},
		Drawer: {
			classNames: { root: "nf-overlay-layer", inner: "nf-drawer-inner" },
		},
		Menu: { classNames: { dropdown: "nf-overlay-layer" } },
		Popover: { classNames: { dropdown: "nf-overlay-layer" } },
		HoverCard: { classNames: { dropdown: "nf-overlay-layer" } },
		Combobox: { classNames: { dropdown: "nf-overlay-layer" } },
	},
});
