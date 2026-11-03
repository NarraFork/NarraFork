/**
 * file-link-target.ts — which file a right-click landed on, if it landed on a rendered file link.
 *
 * Markdown file links in narrator content are real anchors, but their `href` is an internal
 * marker (`#nf-local-file=…`, or `nf-file://open?…` for an explicit device) that `MarkdownLink`
 * renders from a resolved `FileTarget`. Reading that marker back is the only faithful answer to
 * "which file did this gesture point at": the visible label is prose the model wrote, and the
 * row's own tool metadata belongs to a different block.
 *
 * `getAttribute("href")` rather than `anchor.href`: the property resolves the marker against the
 * page origin, which would turn it into a relative URL and lose the payload.
 *
 * A target is only returned when the marker carries an explicit device and an absolute path.
 * That is `fileTargetFromHref`'s contract with no context supplied, and it is what keeps this
 * helper from inventing a file for a bare relative link — a menu action must not act on a guess.
 */

import type { FileTarget } from "@shared/file-reference";
import { fileTargetFromHref } from "@shared/markdown-file-path";

/** The two marker forms `MarkdownLink` emits for a resolved file target. */
const FILE_LINK_SELECTOR = "a[href^='#nf-local-file='], a[href^='nf-file://open?']";

/** The file behind a right-click, or null when the gesture did not land on a file link. */
export function fileLinkTargetFromEvent(target: EventTarget | null | undefined): FileTarget | null {
	if (!target || typeof (target as Element).closest !== "function") return null;
	const anchor = (target as Element).closest<HTMLAnchorElement>(FILE_LINK_SELECTOR);
	if (!anchor) return null;
	return fileTargetFromHref(anchor.getAttribute("href") ?? undefined);
}
