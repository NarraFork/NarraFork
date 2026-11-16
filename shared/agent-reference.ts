/** Authored agent links use a closed URL shape, never an arbitrary browser scheme. */
const MARKER = "#nf-agent=";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** 14px status icon + 4px breathing room, identical in flow and pretext layout. */
export const AGENT_REFERENCE_STATUS_WIDTH = 18;
export const AGENT_REFERENCE_MAX_WIDTH = 240;
export const AGENT_REFERENCE_PADDING_X = 6;
/** Two neighbouring references leave 4px between their painted backgrounds. */
export const AGENT_REFERENCE_MARGIN_X = 2;
export const AGENT_REFERENCE_MIN_HEIGHT = 20;

/** A reference is a task title, not a nested Markdown document. */
export function normalizeAgentReferenceLabel(label: string): string {
	return label.replace(/\s+/gu, " ").trim();
}

export function agentReferenceHref(id: string): string {
	return `nf-agent://open?id=${encodeURIComponent(id)}`;
}

/** Internal hash survives both Markdown sanitizers without allowing custom protocols. */
export function agentReferenceMarker(id: string): string {
	return `${MARKER}${id}`;
}

export function parseAgentReference(href: string | null | undefined): string | null {
	if (!href || href.length > 256) return null;
	if (href.startsWith(MARKER)) {
		const id = href.slice(MARKER.length);
		return ID.test(id) ? id : null;
	}
	if (!href.startsWith("nf-agent://")) return null;
	try {
		const url = new URL(href);
		const id = url.searchParams.get("id");
		return url.host === "open" &&
			!url.username &&
			!url.password &&
			!url.port &&
			!url.pathname &&
			!url.hash &&
			url.searchParams.size === 1 &&
			id &&
			ID.test(id)
			? id
			: null;
	} catch {
		return null;
	}
}

export function isAgentReference(href: string | null | undefined): boolean {
	return !!href && (href.startsWith(MARKER) || /^nf-agent:/i.test(href));
}
