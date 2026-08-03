import type { CSSProperties } from "react";

/**
 * How tall the directory browser's Modal grows.
 *
 * `dvh`, not `vh`: on mobile `vh` resolves against the *large* viewport (browser
 * chrome retracted), so a `vh`-sized modal overhangs the visible area whenever the
 * URL bar is showing. `dvh` follows what is actually on screen, and Mantine's own
 * Modal metrics (`--modal-y-offset: 5dvh`, content `max-height: 100dvh - 2 * offset`)
 * are already in that unit, so this stays inside the cap it has to live under.
 *
 * A definite height rather than a cap: the browser is a fixed set of panes around one
 * scrolling list, so it should occupy the same box whether the current directory holds
 * two entries or two hundred.
 */
export const DIRECTORY_BROWSER_HEIGHT = "85dvh";

/**
 * Shared Modal styles for every directory-browser host (local and remote).
 *
 * The chain matters. Mantine gives the Modal body no height of its own, so a
 * percentage height inside it resolves against an indefinite parent and collapses to
 * content size — which is why the panes previously needed hardcoded pixel heights and
 * why the listing pane ended up shorter than the space available to it.
 *
 * Making the content a flex column and letting the body take the remaining space hands
 * the browser a definite height without naming the header's: deriving the body as
 * `calc(height - 60px)` would encode Mantine's `min-height: 60px` header as if it were
 * fixed, and a title that wraps on a narrow phone (the exact viewport this layout is
 * for) makes the header taller and pushes the body past the modal's own cap.
 *
 * Lives in a module of its own rather than being exported from `DirectoryPicker`
 * because most hosts load that component lazily; importing a constant from it would
 * pull the whole picker into the parent chunk.
 */
export const DIRECTORY_BROWSER_MODAL_STYLES: Record<"content" | "body", CSSProperties> = {
	content: {
		height: DIRECTORY_BROWSER_HEIGHT,
		display: "flex",
		flexDirection: "column",
	},
	body: {
		padding: 0,
		flex: 1,
		minHeight: 0,
		display: "flex",
		flexDirection: "column",
		overflow: "hidden",
	},
};

/**
 * Root box of a directory browser: fill the Modal body, and let the panes inside
 * derive from it. `minHeight: 0` is what allows it to shrink below its content so the
 * inner scroll areas — not the modal — absorb a long listing.
 */
export const DIRECTORY_BROWSER_ROOT_STYLE: CSSProperties = { flex: 1, minHeight: 0 };
