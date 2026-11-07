/**
 * Ctrl+Up / Ctrl+Down walks the sidebar's rows as they are on screen: sessions, folder
 * headers, and a folder's "N more" / "show fewer" row. No DOM or React here.
 *
 * The rows come from the rendered list (`readNavRows`), not from the tab model, so a
 * collapsed folder is one stop (its header) and a preview-limited folder ends with its
 * "N more" row: Enter on those opens them, and the next press walks into what appeared.
 * Walking down past the last row wraps to the first, and back up.
 */

/** A stop for Ctrl+Up / Ctrl+Down. */
export interface NavRowStop {
	/** `narrator:id`, `project:id`, `folder:id` or `strip:folderId` (the "N more" row). */
	key: string;
	kind: "tab" | "folder" | "strip";
}

/** The key of the "N more" row of folder `folderId`. */
export function stripKey(folderId: string): string {
	return `strip:${folderId}`;
}

/**
 * The next stop from `from` (the highlight, else the open page), or null when there are
 * no rows. Without a current row it starts at the first row going down, the last going up.
 */
export function nextNavRow(
	rows: readonly NavRowStop[],
	from: string | null,
	direction: "up" | "down",
): NavRowStop | null {
	if (rows.length === 0) return null;
	const index = from === null ? -1 : rows.findIndex((row) => row.key === from);
	if (index === -1) return direction === "down" ? rows[0] : rows[rows.length - 1];
	const step = direction === "down" ? 1 : -1;
	return rows[(index + step + rows.length) % rows.length];
}

/** Attribute on every row the keys can stop on (sessions and folder headers carry it). */
const ROW_SELECTOR = "[data-tab-sort-id], [data-folder-strip]";

/**
 * The stops in `list`, top to bottom as rendered. Sessions and folder headers carry
 * `data-tab-sort-id`; the "N more" row carries `data-folder-strip`.
 */
export function readNavRows(list: ParentNode): NavRowStop[] {
	const rows: NavRowStop[] = [];
	for (const el of list.querySelectorAll(ROW_SELECTOR)) {
		const strip = el.getAttribute("data-folder-strip");
		if (strip !== null) {
			rows.push({ key: stripKey(strip), kind: "strip" });
			continue;
		}
		const key = el.getAttribute("data-tab-sort-id");
		if (key) rows.push({ key, kind: key.startsWith("folder:") ? "folder" : "tab" });
	}
	return rows;
}

/**
 * The stop showing as active (the open page's row, or the header of the collapsed folder
 * hiding it), where the keys start when nothing is highlighted yet.
 */
export function activeNavRowKey(list: ParentNode): string | null {
	for (const el of list.querySelectorAll(ROW_SELECTOR)) {
		if (!el.hasAttribute("data-active") && !el.querySelector("[data-active]")) continue;
		const strip = el.getAttribute("data-folder-strip");
		return strip !== null ? stripKey(strip) : el.getAttribute("data-tab-sort-id");
	}
	return null;
}

/** Where a session or project stop leads; null for a folder or its "N more" row. */
export function navRowUrl(key: string): string | null {
	const colon = key.indexOf(":");
	const id = key.slice(colon + 1);
	if (colon === -1 || !id) return null;
	const type = key.slice(0, colon);
	if (type === "narrator") return `/narrators/${id}`;
	if (type === "project") return `/projects/${id}`;
	return null;
}

/** The element of stop `key` in `list`, null when it is not rendered. */
export function navRowElement(list: ParentNode, key: string): Element | null {
	for (const el of list.querySelectorAll(ROW_SELECTOR)) {
		const strip = el.getAttribute("data-folder-strip");
		if (strip !== null ? stripKey(strip) === key : el.getAttribute("data-tab-sort-id") === key) {
			return el;
		}
	}
	return null;
}
