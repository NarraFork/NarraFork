/**
 * One Tabler icon's module of `@tabler/icons-react`: the React component and the SVG nodes it
 * draws (`__iconNode`). The package ships no types for these paths; the outline's native DOM
 * frames build inline SVG from the nodes (frontend/components/outline/outline-icons.ts).
 */
declare module "@tabler/icons-react/dist/esm/icons/*.mjs" {
	import type { IconNode, TablerIcon } from "@tabler/icons-react";

	export const __iconNode: IconNode;
	const Icon: TablerIcon;
	export default Icon;
}
