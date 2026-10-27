/**
 * The links a block's state produces, as they are stored in `outline_links`.
 *
 * - content: `[[target]]` is a `link`, `![[target]]` an `embed` (code is never searched);
 * - task: each `depends::` target is a `depends` link;
 * - tags: each tag is a `tag` link to the tag's page.
 *
 * A target written as an address (`key/sid`) is stored as `block` with the canonical address;
 * anything else (an alias, a title, a bare short id) is stored as `text`, trimmed. Turning those
 * into block addresses is resolution, which needs the database and happens elsewhere.
 * Pure functions; no database access.
 */
import { type Body, bodyRefs, formatAddress, parseAddress, parseBlock } from "@shared/outline";
import type { OutlineLinkKind, OutlineLinkTargetKind, OutlineTaskJson } from "./model";

export interface ExtractedLink {
	kind: OutlineLinkKind;
	targetKind: OutlineLinkTargetKind;
	targetRef: string;
}

/** Identity of a link row for diffing: same kind and target is the same link. */
export function linkKey(link: ExtractedLink): string {
	return `${link.kind}\u0000${link.targetKind}\u0000${link.targetRef}`;
}

export function linkTarget(target: string): Pick<ExtractedLink, "targetKind" | "targetRef"> {
	const trimmed = target.trim();
	const address = parseAddress(trimmed);
	return address
		? { targetKind: "block", targetRef: formatAddress(address) }
		: { targetKind: "text", targetRef: trimmed };
}

function dedupe(links: ExtractedLink[]): ExtractedLink[] {
	const seen = new Set<string>();
	return links.filter((link) => {
		const key = linkKey(link);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** `link` and `embed` rows of canonical block content, deduplicated, in document order. */
export function contentLinks(content: string): ExtractedLink[] {
	return bodyLinks(parseBlock(content).body);
}

/** {@link contentLinks} of a body already parsed. */
export function bodyLinks(body: Body): ExtractedLink[] {
	return dedupe(
		bodyRefs(body).map((ref) => ({
			kind: ref.kind === "embed" ? "embed" : "link",
			...linkTarget(ref.ref),
		})),
	);
}

export function dependsLinks(task: OutlineTaskJson | null): ExtractedLink[] {
	return dedupe((task?.depends ?? []).map((d) => ({ kind: "depends", ...linkTarget(d.target) })));
}

export function tagLinks(tags: readonly string[]): ExtractedLink[] {
	return dedupe(tags.map((tag) => ({ kind: "tag", ...linkTarget(tag) })));
}

/** Which link kinds each part of a block's state produces. */
export const CONTENT_LINK_KINDS: ReadonlySet<OutlineLinkKind> = new Set(["link", "embed"]);
export const TASK_LINK_KINDS: ReadonlySet<OutlineLinkKind> = new Set(["depends"]);
export const TAG_LINK_KINDS: ReadonlySet<OutlineLinkKind> = new Set(["tag"]);
