/**
 * Outline places as URLs, without a router: the outline routes' paths and the reference route.
 *
 *   /outline                                  the outline home
 *   /outline/<spaceId>                        a space's pages
 *   /outline/<spaceId>/<blockId>[?view=all][&asOf=12]   a page, or a block focused as one
 *   /outline/ref?a=<key/sid>[&space=<key>]    whatever a reference names (resolved on arrival)
 *   /outline/ref?space=<key>&commit=<seq>     the page a commit changed, as of the commit
 *
 * Tool cards name blocks by address and commits by seq, so they link to the reference route;
 * people paste page URLs into chat. Inside a session surface such links open an outline panel
 * (`outline-opener.tsx`); anywhere else they are ordinary links. Parsing accepts the path with
 * or without the app's mount prefix, and absolute URLs of this origin only.
 */
import { assetUrl, stripBase } from "./base-path";

export type OutlineHrefTarget =
	| { kind: "home" }
	| { kind: "space"; spaceId: string }
	| { kind: "block"; spaceId: string; blockId: string; view?: "all"; asOf?: number }
	/** A reference (`key/sid`, `key/alias`, or a bare one within `space`). */
	| { kind: "ref"; ref: string; space?: string }
	/** A commit of `space` (a key or an id). */
	| { kind: "commit"; space: string; seq: number };

/** Characters a reference may have in a link (the resolve route's own limit). */
export const OUTLINE_HREF_MAX_REF = 300;
/** Characters of an href worth parsing at all. */
const MAX_HREF = 2048;
/** Space, block and page ids, space keys: nanoids and short ids. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

function isId(value: string | null | undefined): value is string {
	return typeof value === "string" && ID.test(value);
}

function seqOf(value: string | null): number | undefined {
	if (value === null || !/^\d{1,15}$/.test(value)) return undefined;
	const seq = Number(value);
	return Number.isSafeInteger(seq) ? seq : undefined;
}

/** The target's path under the app root (no mount prefix), with its query. */
export function outlineTargetPath(target: OutlineHrefTarget): string {
	const enc = encodeURIComponent;
	switch (target.kind) {
		case "home":
			return "/outline";
		case "space":
			return `/outline/${enc(target.spaceId)}`;
		case "block": {
			const query = new URLSearchParams();
			if (target.view === "all") query.set("view", "all");
			if (target.asOf !== undefined) query.set("asOf", String(target.asOf));
			const search = query.toString();
			return `/outline/${enc(target.spaceId)}/${enc(target.blockId)}${search ? `?${search}` : ""}`;
		}
		case "ref": {
			const query = new URLSearchParams({ a: target.ref });
			if (target.space) query.set("space", target.space);
			return `/outline/ref?${query.toString()}`;
		}
		case "commit":
			return `/outline/ref?${new URLSearchParams({ space: target.space, commit: String(target.seq) }).toString()}`;
	}
}

/** The target's URL in this app (mount prefix included): what anchors and copied links use. */
export function outlineTargetHref(target: OutlineHrefTarget): string {
	return assetUrl(outlineTargetPath(target));
}

/** Absolute URL of the target on this origin (for text that leaves the page, like a message). */
export function outlineTargetUrl(target: OutlineHrefTarget): string {
	const href = outlineTargetHref(target);
	if (typeof window === "undefined" || !window.location?.origin) return href;
	return new URL(href, window.location.origin).toString();
}

/**
 * The outline place an href names, or null when it is not an outline link of this app. A
 * relative path (`/outline/…`, with or without the mount prefix) or an absolute URL of this
 * origin; a link to another host is never taken.
 */
export function parseOutlineHref(
	href: string | null | undefined,
	origin: string | null = typeof window !== "undefined" ? (window.location?.origin ?? null) : null,
): OutlineHrefTarget | null {
	if (!href || href.length > MAX_HREF || !href.includes("outline")) return null;
	let url: URL;
	try {
		// Only rooted paths and absolute URLs: `outline/x` relative to some page is not ours.
		if (href.startsWith("/") && !href.startsWith("//"))
			url = new URL(href, "http://outline.invalid");
		else {
			url = new URL(href);
			if (!origin || url.origin !== origin) return null;
		}
	} catch {
		return null;
	}
	let segments: string[];
	try {
		segments = stripBase(url.pathname)
			.split("/")
			.filter((part) => part !== "")
			.map((part) => decodeURIComponent(part));
	} catch {
		return null;
	}
	if (segments[0] !== "outline" || segments.length > 3) return null;
	const query = url.searchParams;
	if (segments.length === 1) return { kind: "home" };
	if (segments.length === 2 && segments[1] === "ref") {
		const space = query.get("space");
		const commit = seqOf(query.get("commit"));
		if (commit !== undefined) return isId(space) ? { kind: "commit", space, seq: commit } : null;
		const ref = query.get("a")?.trim();
		if (!ref || ref.length > OUTLINE_HREF_MAX_REF) return null;
		return { kind: "ref", ref, ...(isId(space) ? { space } : {}) };
	}
	const spaceId = segments[1];
	if (!isId(spaceId)) return null;
	if (segments.length === 2) return { kind: "space", spaceId };
	const blockId = segments[2];
	if (!isId(blockId)) return null;
	const asOf = seqOf(query.get("asOf"));
	return {
		kind: "block",
		spaceId,
		blockId,
		...(query.get("view") === "all" ? { view: "all" as const } : {}),
		...(asOf !== undefined ? { asOf } : {}),
	};
}

/** Whether an href is an outline link of this app (cheap enough for every rendered link). */
export function isOutlineHref(href: string | null | undefined): boolean {
	return parseOutlineHref(href) !== null;
}

/** Whether an href is a tool card's reference or commit link (`/outline/ref?…`). */
export function isOutlineReferenceHref(href: string | null | undefined): boolean {
	const target = href?.includes("/outline/ref") ? parseOutlineHref(href) : null;
	return target?.kind === "ref" || target?.kind === "commit";
}
