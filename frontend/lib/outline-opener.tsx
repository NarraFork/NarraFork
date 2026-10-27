/**
 * Opening outline places from anywhere inside a host: a session's tool cards and chat links, a
 * panel's own Ctrl/Cmd-clicks, the session menu.
 *
 * A host is whatever can show an outline panel: the session page's side dock, a workspace
 * narrator's cluster, the outline page's dock, or a session's own drawer when it has no dock
 * (a phone, a detached window). It provides an `OutlineOpener`; links inside it consult the
 * nearest one. Without an opener (outline off, or a surface that is not a host) links stay
 * ordinary links and nothing is intercepted.
 */
import { notifications } from "@mantine/notifications";
import i18n from "i18next";
import { createContext, type ReactNode, useCallback, useContext, useMemo } from "react";
import { ApiError, api } from "./api";
import { type OutlineHrefTarget, outlineTargetHref, parseOutlineHref } from "./outline-href";
import type { OutlinePanelState } from "./outline-panel";

export interface OutlineOpenOptions {
	/** Open a new panel even when one already shows the page (Ctrl/Cmd-click). */
	newPanel?: boolean;
}

export interface OutlineOpener {
	/** Open the place in this host; false when the host cannot right now (no dock mounted). */
	open: (state: OutlinePanelState, options?: OutlineOpenOptions) => boolean;
}

const OutlineOpenerContext = createContext<OutlineOpener | null>(null);

export function OutlineOpenerProvider({
	value,
	children,
}: {
	value: OutlineOpener | null;
	children: ReactNode;
}) {
	return <OutlineOpenerContext.Provider value={value}>{children}</OutlineOpenerContext.Provider>;
}

/** The nearest host's opener, or null outside any host. */
export function useOutlineOpener(): OutlineOpener | null {
	return useContext(OutlineOpenerContext);
}

/** Whether a click asks for a new panel (Ctrl on Windows and Linux, Cmd on macOS). */
export function wantsNewPanel(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
	return event.ctrlKey === true || event.metaKey === true;
}

/** Whether a click is one the page should handle itself (a plain or Ctrl/Cmd primary click). */
export function isOpenClick(event: {
	button: number;
	shiftKey: boolean;
	altKey: boolean;
	defaultPrevented: boolean;
}): boolean {
	return !event.defaultPrevented && event.button === 0 && !event.shiftKey && !event.altKey;
}

/**
 * The panel state an outline link opens, or null when it names nothing the person can read.
 * References and commits are resolved by the server (permission checked, an unreadable place
 * answers like a missing one); a block is read once to learn its page, so a block of a page
 * that already has a panel opens in that panel.
 */
export async function outlineStateForHref(
	target: OutlineHrefTarget,
): Promise<OutlinePanelState | null> {
	switch (target.kind) {
		case "home":
			return {};
		case "space":
			return { spaceId: target.spaceId };
		case "block": {
			const state: OutlinePanelState = {
				spaceId: target.spaceId,
				blockId: target.blockId,
				...(target.view ? { view: target.view } : {}),
				...(target.asOf !== undefined ? { asOf: target.asOf } : {}),
			};
			try {
				const view = await api.getOutlineBlock(target.spaceId, target.blockId, {
					blocks: 1,
					view: target.view ?? "facts",
					asOf: target.asOf,
				});
				return { ...state, pageId: view.pageId };
			} catch {
				// The panel shows the answer itself (not found, or no access).
				return state;
			}
		}
		case "ref":
		case "commit": {
			try {
				const found = await api.resolveOutline(
					target.kind === "ref"
						? { ref: target.ref, space: target.space }
						: { space: target.space, commit: target.seq },
				);
				return {
					spaceId: found.spaceId,
					blockId: found.blockId,
					pageId: found.pageId,
					...(found.asOf !== undefined ? { asOf: found.asOf } : {}),
					...(found.title ? { title: found.title } : {}),
				};
			} catch (error) {
				if (error instanceof ApiError && error.status === 404) return null;
				throw error;
			}
		}
	}
}

/**
 * Open an outline link in the nearest host, or null when there is no host (the caller keeps
 * the link ordinary). A link that names nothing readable says so instead of opening.
 */
export function useOpenOutlineHref():
	| ((target: OutlineHrefTarget, options?: OutlineOpenOptions) => void)
	| null {
	const opener = useOutlineOpener();
	const open = useCallback(
		(target: OutlineHrefTarget, options?: OutlineOpenOptions) => {
			if (!opener) return;
			void outlineStateForHref(target)
				.then((state) => {
					if (state === null) {
						void notifyOutline("gray", "link.notFound");
						return;
					}
					opener.open(state, options);
				})
				.catch(() => void notifyOutline("red", "loadFailed"));
		},
		[opener],
	);
	return opener ? open : null;
}

/**
 * A notice in the outline's words. Loaded on demand rather than through `useTranslation`, so
 * that every rendered link does not suspend on the outline namespace.
 */
async function notifyOutline(color: string, key: string): Promise<void> {
	try {
		await i18n.loadNamespaces("outline");
	} catch {
		// The key itself is shown below.
	}
	notifications.show({ color, message: i18n.t(key, { ns: "outline" }) });
}

/** An outline link's anchor props in this host (see `useOutlineLinkProps`). */
export interface OutlineLinkAnchor {
	href: string;
	onClick: (event: React.MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * How to render an href that may be an outline link: `undefined` when it is not one (render it
 * as before), `null` when it is one but nothing here can open it (render plain text: the outline
 * is off, or this is not a session surface), else the anchor's href (with the mount prefix) and
 * a click that opens it beside (Ctrl/Cmd: in a new panel).
 */
export function useOutlineLinkProps(
	href: string | null | undefined,
): OutlineLinkAnchor | null | undefined {
	const open = useOpenOutlineHref();
	const target = useMemo(() => (href ? parseOutlineHref(href) : null), [href]);
	return useMemo(() => {
		if (!target) return undefined;
		if (!open) return null;
		return {
			href: outlineTargetHref(target),
			onClick: (event: React.MouseEvent<HTMLAnchorElement>) => {
				if (!isOpenClick(event)) return;
				event.preventDefault();
				event.stopPropagation();
				open(target, { newPanel: wantsNewPanel(event) });
			},
		};
	}, [target, open]);
}
