/**
 * Publishes the reader's typography (外观 · 排版) as `--nf-type-*` custom properties on
 * `<html>`, for every surface the browser lays out itself: the outline editor and read-only
 * tree, the mind map's nodes, the task board. The values come from
 * `shared/pretext-layout/typography-css.ts`, i.e. from the same metrics the transcript
 * measures with, so one setting moves the transcript and the outline together.
 *
 * Installed once and kept current through `onTypographyChange`, so a slider drag in the
 * 外观 panel previews in the outline exactly as it does in the transcript. The installer is
 * idempotent: `useAuthenticatedAppearance` calls it for the app, and each surface that paints
 * with the variables calls it too, so a surface mounted on its own (a test fixture, a page
 * outside the authenticated shell) never paints with them unset.
 *
 * Importing this module also brings in `.nf-type-scope` (styles/typography-scope.css).
 */
import { onTypographyChange } from "@shared/pretext-layout/typography";
import { TYPOGRAPHY_CSS_VARS, typographyCssVariables } from "@shared/pretext-layout/typography-css";
import "../styles/typography-scope.css";

/** Write the current values onto `root`. */
export function applyTypographyCssVars(root: HTMLElement): void {
	for (const [name, value] of Object.entries(typographyCssVariables())) {
		root.style.setProperty(name, value);
	}
}

let installed = false;

/** Publish on `<html>` now and on every typography change (once per page). */
export function ensureTypographyCssVars(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	const root = document.documentElement;
	applyTypographyCssVars(root);
	onTypographyChange(() => applyTypographyCssVars(root));
}

const cssVar = (name: string) => `var(${name})`;
const V = TYPOGRAPHY_CSS_VARS;

/**
 * Inline styles for one text role, for Mantine components that take `style` (a `Text` with
 * `size="sm"` would otherwise keep Mantine's own 14px / 1.45).
 */
export const TYPE_ROLE_STYLE = {
	body: {
		fontSize: cssVar(V.bodySize),
		lineHeight: cssVar(V.bodyLine),
		letterSpacing: cssVar(V.letterSpacing),
	},
	xs: {
		fontSize: cssVar(V.xsSize),
		lineHeight: cssVar(V.xsLine),
		letterSpacing: cssVar(V.letterSpacing),
	},
	code: {
		fontSize: cssVar(V.codeSize),
		lineHeight: cssVar(V.xsLine),
		letterSpacing: cssVar(V.letterSpacing),
	},
	/**
	 * A small multiline field (a permission card's textarea): xs text on the BASE line box (the
	 * 1.55 Mantine gives multiline inputs) under the reader's line-height setting, which is how
	 * the transcript's height model counts each of its rows.
	 */
	textarea: {
		fontSize: cssVar(V.xsSize),
		lineHeight: cssVar(V.xsBaseLine),
		letterSpacing: cssVar(V.letterSpacing),
	},
} as const;
