import { localFileHref, parseLocalFilePath } from "@shared/markdown-file-path";
import type { Parent, Root } from "mdast";

/** Normalize authored file-link destinations, never infer links from prose or inline code. */
export function remarkLocalFileLinks() {
	return (tree: Root) => {
		const walk = (parent: Parent) => {
			for (const node of parent.children) {
				if (node.type === "link" || node.type === "definition") {
					// Explicit special destinations become inert markers before the normal
					// URL sanitizer. The label and all non-link text remain untouched.
					if (/^(?:file:|nf-file:|[a-z]:[\\/])/i.test(node.url)) {
						const target = parseLocalFilePath(node.url);
						if (target) node.url = localFileHref(target);
					}
					continue;
				}
				if ("children" in node) walk(node);
			}
		};
		walk(tree);
	};
}
