/**
 * The live outline editor in an outline page's view area: one page's live session
 * (`live-client.ts`), an editor view rooted at the focused block (`view.ts`), who else is here,
 * and the notices a live page needs (connecting, offline, read only, deleted by someone else).
 *
 * The session lives per page and socket, not per mount (`live-sessions.ts`): every editor of a
 * page in this tab (the outline page, dock panels) shares one session client, so one socket
 * session and one undo stack per person and page; moving the focus keeps it; it closes a little
 * after the last editor of the page unmounts. A page the tab has no room for (the socket's
 * session limit, every session in use) is not joined: the surface shows it read only and says
 * why. What is folded, selected and on screen is the surface's own (`viewState`).
 * Keys are the editor's own (its ProseMirror keymap): nothing listens on the document, so a
 * composer next to the editor keeps its keys.
 */
import { Alert, Avatar, Badge, Button, Group, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { LiveCloseCode } from "@shared/outline-live-protocol";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { OutlineViewState } from "../view-state";
import { chromeText } from "./chrome";
import type { LiveClient, LiveTransport } from "./live-client";
import {
	acquireLiveSession,
	releaseLiveSession,
	retainLiveSession,
	type SharedLiveSession,
} from "./live-sessions";
import { liveTransport } from "./transport";
import { type OutlineLens, OutlineView } from "./view";
import "./editor.css";

/** How long the editor waits for its first snapshot before the page shows the read-only view. */
const CONNECT_TIMEOUT_MS = 8_000;

export interface OutlineEditorProps {
	pageId: string;
	/** The focused block (the page itself when unfocused). */
	focusId: string;
	/** The space key, for resolving `[[key/sid]]` mentions to blocks of this page. */
	spaceKey: string;
	/** Whether the person may write the space (they join as a viewer otherwise). */
	canWrite: boolean;
	lens: OutlineLens;
	/** The surface's view state of this page (folding, caret, block selection). */
	viewState: OutlineViewState;
	/** Focus a block (the surface's host navigates). */
	onFocus: (blockId: string) => void;
	/**
	 * Live editing is not possible here; the page falls back to the read-only view. `tab_limit`:
	 * this tab already has as many pages open live as its socket takes, all on screen.
	 */
	onUnavailable: (reason: OutlineLiveUnavailable) => void;
	/** Blocks the facts view leaves out, for the page's hint. */
	onHiddenChange?: (count: number) => void;
	/** Tests: the transport to use instead of the narrator socket. */
	transport?: LiveTransport;
	/** Tests: the session client and the current view. */
	onClient?: (client: LiveClient, view: () => OutlineView | null) => void;
}

/** Why a page shows read only instead of the live editor. */
export type OutlineLiveUnavailable = LiveCloseCode | "timeout" | "tab_limit";

export function OutlineEditor(props: OutlineEditorProps) {
	const { pageId, canWrite } = props;
	const mode = canWrite ? "edit" : "view";
	const transport = props.transport ?? liveTransport();
	const shared = useMemo(
		() => acquireLiveSession(transport, pageId, mode),
		[transport, pageId, mode],
	);
	const onUnavailable = useRef(props.onUnavailable);
	onUnavailable.current = props.onUnavailable;
	useEffect(() => {
		if (!shared) onUnavailable.current("tab_limit");
	}, [shared]);
	if (!shared) return null;
	return <LiveOutlineEditor {...props} shared={shared} />;
}

function LiveOutlineEditor(props: OutlineEditorProps & { shared: SharedLiveSession }) {
	const { focusId, lens, spaceKey, viewState, shared } = props;
	const { t } = useTranslation("outline");
	const client = shared.client;
	useEffect(() => {
		retainLiveSession(shared);
		return () => releaseLiveSession(shared);
	}, [shared]);
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const mount = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<OutlineView | null>(null);
	const callbacks = useRef(props);
	callbacks.current = props;
	const [refusal, setRefusal] = useState<"too-large" | "root" | null>(null);

	chromeText.fold = t("page.collapse");
	chromeText.focus = t("page.focus");
	chromeText.task = t("editor.changeStatus");
	chromeText.hidden = (count) => t("editor.hiddenUnder", { count });

	useEffect(() => {
		callbacks.current.onClient?.(client, () => viewRef.current);
	}, [client]);

	// Client events re-render the bar; losing the session for good falls back to read only.
	useEffect(() => {
		const off = client.on((event) => {
			if (event === "status" || event === "readonly") viewRef.current?.refreshEditable();
			if (event === "closed" && client.closeCode && client.closeCode !== "ended")
				callbacks.current.onUnavailable(client.closeCode);
			if (event === "sync") callbacks.current.onHiddenChange?.(viewRef.current?.hiddenByLens ?? 0);
			if (event !== "sync") rerender();
		});
		if (client.status === "closed" && client.closeCode)
			callbacks.current.onUnavailable(client.closeCode);
		const timer = setTimeout(() => {
			if (!client.ready) callbacks.current.onUnavailable("timeout");
		}, CONNECT_TIMEOUT_MS);
		return () => {
			off();
			clearTimeout(timer);
		};
	}, [client]);

	// The editor view, rooted at the focused block. The lens is applied below without
	// rebuilding the view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the lens is set by its own effect
	useEffect(() => {
		const host = mount.current;
		if (!host) return;
		const state = viewState;
		state.setFocus(focusId);
		const resolveMention = (ref: string): string | null => {
			const slash = ref.lastIndexOf("/");
			const key = slash > 0 ? ref.slice(0, slash) : spaceKey;
			const sid = ref.slice(slash + 1);
			if (key !== spaceKey) return null;
			for (const b of client.visible.blocks.values()) {
				if (b.sid === sid && !b.deleted) return client.textOf(b.id);
			}
			return null;
		};
		const subtreeWithKids = (): string[] => {
			const out: string[] = [];
			const stack = [focusId];
			while (stack.length > 0) {
				const id = stack.pop() as string;
				const kids = client.visible.children(id);
				if (kids.length > 0 && id !== focusId) out.push(id);
				stack.push(...kids);
			}
			return out;
		};
		const view = new OutlineView(client, { kind: "focus", rootId: focusId }, host, {
			lens,
			collapsed: state.collapsed,
			resolveMention,
			onBullet: (id) => callbacks.current.onFocus(id),
			onCollapse: () => state.noteCollapsed(),
			onSelect: (blockId) => state.setCaret({ blockId, anchor: -1, head: -1 }),
			onBlockSelection: (ids) => state.setBlocks(ids),
			onRefused: (reason) => setRefusal(reason),
			keys: {
				"Alt-ArrowRight": () => {
					const id = view.captureSel()?.head.blockId;
					if (id && id !== focusId) callbacks.current.onFocus(id);
					return true;
				},
				"Alt-ArrowLeft": () => {
					const parent = client.visible.get(focusId)?.parentId;
					if (parent) callbacks.current.onFocus(parent);
					return true;
				},
				"Mod-ArrowUp": () => {
					state.setCollapsed(subtreeWithKids(), true);
					view.sync();
					return true;
				},
				"Mod-ArrowDown": () => {
					state.setCollapsed(subtreeWithKids(), false);
					view.sync();
					return true;
				},
			},
		});
		viewRef.current = view;
		const offState = state.on((part) => {
			if (part === "collapsed") view.sync();
		});
		callbacks.current.onHiddenChange?.(view.hiddenByLens);
		return () => {
			offState();
			view.destroy();
			if (viewRef.current === view) viewRef.current = null;
		};
	}, [client, focusId, viewState, spaceKey]);

	useEffect(() => {
		viewRef.current?.setLens(lens);
		callbacks.current.onHiddenChange?.(viewRef.current?.hiddenByLens ?? 0);
	}, [lens]);

	useEffect(() => {
		if (!refusal) return;
		notifications.show({
			color: "yellow",
			message: t(refusal === "too-large" ? "editor.tooLarge" : "editor.rootKept"),
		});
		setRefusal(null);
	}, [refusal, t]);

	const peers = [...client.presence.values()];
	const status = client.status;
	const deleted = client.deleted;

	return (
		<div className="nf-outline-editor" data-status={status} data-testid="outline-editor">
			<Group gap="xs" justify="space-between" wrap="wrap" className="nf-outline-editor-bar">
				<Group gap={6} wrap="nowrap" className="nf-outline-presence">
					{peers.length > 0 && (
						<Avatar.Group spacing={6}>
							{peers.slice(0, 6).map((p) => (
								<Tooltip
									key={p.pno}
									label={t(p.editing ? "editor.peerEditing" : "editor.peerViewing", {
										name: p.name || t("editor.someone"),
									})}
								>
									<Avatar size={22} radius="xl" style={{ background: p.color, color: "#fff" }}>
										{(p.name || "?").slice(0, 1).toUpperCase()}
									</Avatar>
								</Tooltip>
							))}
							{peers.length > 6 && (
								<Avatar size={22} radius="xl">
									+{peers.length - 6}
								</Avatar>
							)}
						</Avatar.Group>
					)}
				</Group>
				<Group gap={6} wrap="nowrap">
					{!client.canWrite && client.ready && (
						<Badge size="sm" variant="light" color="gray">
							{t("editor.readOnly")}
						</Badge>
					)}
					{status === "connecting" && (
						<Badge size="sm" variant="light" color="gray">
							{t("editor.connecting")}
						</Badge>
					)}
					{status === "offline" && (
						<Badge size="sm" variant="light" color="orange">
							{t("editor.offline")}
						</Badge>
					)}
					{status === "stalled" && (
						<Badge size="sm" variant="light" color="red">
							{t("editor.stalled")}
						</Badge>
					)}
				</Group>
			</Group>
			{deleted && (
				<Alert color="yellow" variant="light" py={6} data-testid="outline-deleted-notice">
					<Group gap="xs" wrap="wrap">
						<Text size="sm">
							{deleted.by
								? t("editor.deletedBy", { name: deleted.by })
								: t("editor.deletedBySomeone")}
						</Text>
						{client.editable && (
							<Button size="compact-xs" variant="light" onClick={() => client.restoreDeleted()}>
								{t("editor.restore")}
							</Button>
						)}
						<Button size="compact-xs" variant="subtle" onClick={() => client.dismissDeleted()}>
							{t("editor.dismiss")}
						</Button>
					</Group>
				</Alert>
			)}
			<div ref={mount} className="nf-outline-editor-host" />
		</div>
	);
}
