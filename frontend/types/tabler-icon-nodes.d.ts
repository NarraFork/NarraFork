/**
 * The SVG nodes (`__iconNode`) of the Tabler icons the outline's native DOM frames draw
 * (frontend/components/outline/outline-icons.ts), one module of `@tabler/icons-react` each; the
 * package ships no types for these paths. Each path is named, not matched by a wildcard, so the
 * type check refuses any other (a typo); an icon added there is added here. A file Tabler drops
 * still fails the build and the unit tests, which import it.
 */
declare module "@tabler/icons-react/dist/esm/icons/IconChevronDown.mjs" {
	export const __iconNode: import("@tabler/icons-react").IconNode;
}

declare module "@tabler/icons-react/dist/esm/icons/IconChevronRight.mjs" {
	export const __iconNode: import("@tabler/icons-react").IconNode;
}

declare module "@tabler/icons-react/dist/esm/icons/IconHelpCircle.mjs" {
	export const __iconNode: import("@tabler/icons-react").IconNode;
}

declare module "@tabler/icons-react/dist/esm/icons/IconSquare.mjs" {
	export const __iconNode: import("@tabler/icons-react").IconNode;
}

declare module "@tabler/icons-react/dist/esm/icons/IconSquareCheck.mjs" {
	export const __iconNode: import("@tabler/icons-react").IconNode;
}

declare module "@tabler/icons-react/dist/esm/icons/IconSquareHalf.mjs" {
	export const __iconNode: import("@tabler/icons-react").IconNode;
}

declare module "@tabler/icons-react/dist/esm/icons/IconSquareX.mjs" {
	export const __iconNode: import("@tabler/icons-react").IconNode;
}
