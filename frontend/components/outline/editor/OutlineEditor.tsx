/**
 * The live outline editor in an outline page's view area: one page's live session
 * (`live-client.ts`), its editing surface with two views — the outline and the mind map
 * (`../edit-surface.ts`, design §6.10) — who else is here, and the notices a live page needs
 * (connecting, offline, read only, deleted by someone else).
 *
 * The session lives per page and socket, not per mount (`live-sessions.ts`): every editor of a
 * page in this tab (the outline page, dock panels) shares one session client, so one socket
 * session and one undo stack per person and page; moving the focus keeps it; it closes a little
 * after the last editor of the page unmounts. A page the tab has no room for (the socket's
 * session limit, every session in use) is not joined: the surface shows it read only and says
 * why. What is folded, selected, on screen and in which view is the surface's own (`viewState`).
 *
 * Focus is the host's (`focusId` in, `onFocus` out): the editing surface animates a focus change
 * at once and tells the host, and recognises the host's answer; a focus the host sets by itself
 * (back, forward, a breadcrumb) animates when it arrives. Focusing never rebuilds the editor.
 *
 * Keys are the editor's own (its ProseMirror keymap and the map's stage): nothing listens on the
 * document, so a composer next to the editor keeps its keys.
 */
import {
	ActionIcon,
	Alert,
	Avatar,
	Badge,
	Button,
	Group,
	SegmentedControl,
	Text,
	Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { OutlineBlockViewResponse } from "@shared/outline-api";
import type { LiveCloseCode } from "@shared/outline-live-protocol";
import { IconArrowDown, IconArrowRight, IconArrowsMaximize, IconSearch } from "@tabler/icons-react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditSurface } from "../edit-surface";
import { mapText } from "../mindmap/mindmap";
import type { OutlineViewState } from "../view-state";
import { chromeText } from "./chrome";
import type { LiveClient, LiveTransport } from "./live-client";
import {
	acquireLiveSession,
	liveSessionClient,
	releaseLiveSession,
	retainLiveSession,
	type SharedLiveSession,
} from "./live-sessions";
import { readCanGoLive, seedBlocksOf } from "./seed";
import { liveTransport } from "./transport";
import { UnsavedTextsNotice } from "./UnsavedTextsNotice";
import type { OutlineLens, OutlineRefusal, OutlineView } from "./view";
import "./editor.css";
import "../mindmap/mindmap.css";

/** How long the editor waits for its first snapshot before the page shows the read-only view. */
const CONNECT_TIMEOUT_MS = 8_000;

/** The focused block as the live page has it: for breadcrumbs that follow focus at once. */
export interface OutlineFocusInfo {
	pageId: string;
	rootId: string;
	/** The ancestors, the page first (empty when the page itself is focused). */
	path: Array<{ id: string; sid: string; title: string }>;
	title: string;
	sid: string;
}

export interface OutlineEditorProps {
	pageId: string;
	/** The focused block (the page itself when unfocused). */
	focusId: string;
	/** The space key, for resolving `[[key/sid]]` mentions to blocks of this page. */
	spaceKey: string;
	/** Whether the person may write the space (they join as a viewer otherwise). */
	canWrite: boolean;
	lens: OutlineLens;
	/** The surface's view state of this page (folding, caret, block selection, view). */
	viewState: OutlineViewState;
	/** The focus moved (the surface's host records it). */
	onFocus: (blockId: string) => void;
	/**
	 * Live editing is not possible here; the page falls back to the read-only view. `tab_limit`:
	 * this tab already has as many pages open live as its socket takes, all on screen.
	 */
	onUnavailable: (reason: OutlineLiveUnavailable) => void;
	/** Blocks the facts view leaves out, for the page's hint. */
	onHiddenChange?: (count: number) => void;
	/** The focused block's path and title, whenever they change. */
	onFocusInfo?: (info: OutlineFocusInfo) => void;
	/** The editing surface (the quick switcher focuses through it), and null when it goes. */
	onSurface?: (surface: EditSurface | null) => void;
	/** Open the quick switcher (shown on the toolbar when given). */
	onOpenSwitcher?: () => void;
	/** Tests: the transport to use instead of the narrator socket. */
	transport?: LiveTransport;
	/** Tests: the session client and the current outline view. */
	onClient?: (client: LiveClient, view: () => OutlineView | null) => void;
	/** Tests: measure the map's nodes ahead in a Worker (default on). */
	premeasure?: boolean;
	/**
	 * An HTTP read of the focused block of this page (`view=all`), to show while the session
	 * connects (read-only first): typing is queued, structure waits, and the page turns live in
	 * place when the snapshot arrives.
	 */
	seed?: OutlineBlockViewResponse | null;
}

/**
 * Seed the page's session of this tab with a read as soon as the read arrives, without waiting
 * for a render: the snapshot, often on its way at the same moment, then finds the page shown.
 */
export function seedLiveSession(read: OutlineBlockViewResponse, transport = liveTransport()): void {
	if (!read.current) return;
	for (const mode of ["edit", "view"] as const) {
		const client = liveSessionClient(transport, read.pageId, mode);
		if (client && !client.ready) client.seed(seedBlocksOf(read), { typing: readCanGoLive(read) });
	}
}

/** After the next frame is painted; at most 100 ms later in a tab that paints nothing. */
function afterNextPaint(run: () => void): void {
	let done = false;
	const go = () => {
		if (done) return;
		done = true;
		run();
	};
	requestAnimationFrame(() => setTimeout(go, 0));
	setTimeout(go, 100);
}

/** Why a page shows read only instead of the live editor. */
export type OutlineLiveUnavailable = LiveCloseCode | "timeout" | "tab_limit";

export function OutlineEditor(props: OutlineEditorProps) {
	const { pageId, canWrite } = props;
	const mode = canWrite ? "edit" : "view";
	const transport = props.transport ?? liveTransport();
	const shared = useMemo(() => {
		const s = acquireLiveSession(transport, pageId, mode);
		// A seeded page paints its seed before it turns live.
		if (s) s.client.upgradeAfterPaint ??= afterNextPaint;
		return s;
	}, [transport, pageId, mode]);
	const onUnavailable = useRef(props.onUnavailable);
	onUnavailable.current = props.onUnavailable;
	useEffect(() => {
		if (!shared) onUnavailable.current("tab_limit");
	}, [shared]);
	if (!shared) return null;
	return <LiveOutlineEditor {...props} shared={shared} />;
}

function focusInfoOf(client: LiveClient, pageId: string, rootId: string): OutlineFocusInfo {
	const v = client.visible;
	const path: OutlineFocusInfo["path"] = [];
	let cur = v.get(rootId)?.parentId ?? null;
	for (let guard = 0; cur && guard < 200; guard++) {
		const b = v.get(cur);
		if (!b) break;
		path.unshift({ id: cur, sid: b.sid, title: firstLine(client.textOf(cur)) });
		cur = b.parentId;
	}
	return {
		pageId,
		rootId,
		path,
		title: firstLine(client.textOf(rootId)),
		sid: v.get(rootId)?.sid ?? "",
	};
}

function firstLine(text: string): string {
	return text
		.split("\n")[0]
		?.replace(/^#{1,3}\s+/, "")
		.replace(/[*_`~]/g, "")
		.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
		.trim()
		.slice(0, 120) as string;
}

function LiveOutlineEditor(props: OutlineEditorProps & { shared: SharedLiveSession }) {
	const { focusId, lens, spaceKey, viewState, shared, pageId } = props;
	const { t } = useTranslation("outline");
	const client = shared.client;
	useEffect(() => {
		retainLiveSession(shared);
		return () => releaseLiveSession(shared);
	}, [shared]);
	const [, rerender] = useReducer((n: number) => n + 1, 0);
	const frame = useRef<HTMLDivElement | null>(null);
	const surfaceRef = useRef<EditSurface | null>(null);
	const callbacks = useRef(props);
	callbacks.current = props;
	const [refusal, setRefusal] = useState<OutlineRefusal | null>(null);
	// Structure refused while connecting: the "connecting" badge nudges.
	const [nudge, setNudge] = useState(0);

	chromeText.fold = t("page.collapse");
	chromeText.focus = t("page.focus");
	chromeText.task = t("editor.changeStatus");
	chromeText.hidden = (count) => t("editor.hiddenUnder", { count });
	mapText.more = (count) => t("map.more", { count });
	mapText.stage = t("map.stage");

	useEffect(() => {
		callbacks.current.onClient?.(client, () => surfaceRef.current?.outline ?? null);
	}, [client]);

	// Client events re-render the bar; losing the session for good falls back to read only.
	useEffect(() => {
		const off = client.on((event) => {
			if (event === "status" || event === "readonly") {
				const s = surfaceRef.current;
				if (s) for (const v of [s.pageView, s.focusView]) v?.refreshEditable();
			}
			// Typing it could not save is in the unsaved-text store: the read-only view shows it too.
			if (event === "closed" && client.closeCode && client.closeCode !== "ended")
				callbacks.current.onUnavailable(client.closeCode);
			if (event !== "sync") rerender();
		});
		if (client.status === "closed" && client.closeCode)
			callbacks.current.onUnavailable(client.closeCode);
		// A page shown from its read stays (what was typed is kept for when it goes live); one with
		// nothing to show falls back to the read-only view.
		const timer = setTimeout(() => {
			if (!client.ready && !client.seeded) callbacks.current.onUnavailable("timeout");
		}, CONNECT_TIMEOUT_MS);
		return () => {
			off();
			clearTimeout(timer);
		};
	}, [client]);

	// Read-only first: the page's HTTP read until the session is live (before the surface is
	// built, so its first paint has the page).
	const seed = props.seed;
	useEffect(() => {
		if (seed && seed.pageId === pageId && seed.current && !client.ready)
			client.seed(seedBlocksOf(seed), { typing: readCanGoLive(seed) });
	}, [client, seed, pageId]);

	// The editing surface: built once per page session and view state; focus and lens changes
	// go to it below without rebuilding it.
	const focusRef = useRef(focusId);
	focusRef.current = focusId;
	const lensRef = useRef(lens);
	lensRef.current = lens;
	useEffect(() => {
		const host = frame.current;
		if (!host) return;
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
		const surface = new EditSurface({
			client,
			pageId,
			state: viewState,
			frame: host,
			focusId: focusRef.current,
			lens: lensRef.current,
			resolveMention,
			onFocus: (id) => callbacks.current.onFocus(id),
			onRefused: (reason) => {
				// Each structural key refused while connecting nudges the badge once more.
				if (reason === "connecting") setNudge((n) => n + 1);
				else setRefusal(reason);
			},
			onHiddenChange: (count) => callbacks.current.onHiddenChange?.(count),
			premeasure: callbacks.current.premeasure,
		});
		surfaceRef.current = surface;
		callbacks.current.onSurface?.(surface);
		let infoKey = "";
		let reportTimer: ReturnType<typeof setTimeout> | null = null;
		const report = () => {
			reportTimer = null;
			const info = focusInfoOf(client, pageId, viewState.focus);
			const key = JSON.stringify(info);
			if (key === infoKey) return;
			infoKey = key;
			callbacks.current.onFocusInfo?.(info);
		};
		// After the frame with the new focus is painted: the breadcrumbs' re-render waits.
		const reportSoon = () => {
			if (reportTimer) return;
			reportTimer = setTimeout(report, 16);
		};
		report();
		const offState = viewState.on((part) => {
			if (part === "focus") reportSoon();
			if (part === "view" || part === "layout" || part === "stored") rerender();
		});
		const offClient = client.on((event) => {
			if (event === "sync") reportSoon();
		});
		return () => {
			if (reportTimer) clearTimeout(reportTimer);
			offState();
			offClient();
			surface.destroy();
			if (surfaceRef.current === surface) surfaceRef.current = null;
			callbacks.current.onSurface?.(null);
		};
	}, [client, pageId, viewState, spaceKey]);

	useEffect(() => {
		surfaceRef.current?.focusFromHost(focusId);
	}, [focusId]);
	// After every render: what the host shows (a focus and its return may render as no change).
	useEffect(() => {
		surfaceRef.current?.hostShows(focusId);
	});

	useEffect(() => {
		surfaceRef.current?.setLens(lens);
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
	const view = viewState.view;
	const layout = viewState.layout;

	return (
		<div className="nf-outline-editor" data-status={status} data-testid="outline-editor">
			<Group gap="xs" justify="space-between" wrap="wrap" className="nf-outline-editor-bar">
				<Group gap={6} wrap="nowrap" className="nf-outline-view-tools">
					<SegmentedControl
						size="xs"
						value={view}
						onChange={(value) =>
							surfaceRef.current?.setView(value === "map" ? "map" : "outline", { focus: true })
						}
						data={[
							{ value: "outline", label: t("map.outline") },
							{ value: "map", label: t("map.map") },
						]}
						aria-label={t("map.viewLabel")}
						data-testid="outline-view-switch"
					/>
					{view === "map" && (
						<>
							<Tooltip label={t(layout === "right" ? "map.down" : "map.right")}>
								<ActionIcon
									variant="subtle"
									color="gray"
									size="sm"
									aria-label={t(layout === "right" ? "map.down" : "map.right")}
									data-testid="outline-map-layout"
									onMouseDown={(e) => e.preventDefault()}
									onClick={() =>
										surfaceRef.current?.setLayout(layout === "right" ? "down" : "right")
									}
								>
									{layout === "right" ? <IconArrowDown size={16} /> : <IconArrowRight size={16} />}
								</ActionIcon>
							</Tooltip>
							<Tooltip label={t("map.fit")}>
								<ActionIcon
									variant="subtle"
									color="gray"
									size="sm"
									aria-label={t("map.fit")}
									onMouseDown={(e) => e.preventDefault()}
									onClick={() => surfaceRef.current?.map.fit()}
								>
									<IconArrowsMaximize size={16} />
								</ActionIcon>
							</Tooltip>
						</>
					)}
					{props.onOpenSwitcher && (
						<Tooltip label={t("switcher.open")}>
							<ActionIcon
								variant="subtle"
								color="gray"
								size="sm"
								aria-label={t("switcher.open")}
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => props.onOpenSwitcher?.()}
							>
								<IconSearch size={16} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
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
					{!client.canWrite && client.ready && (
						<Badge size="sm" variant="light" color="gray">
							{t("editor.readOnly")}
						</Badge>
					)}
					{status === "connecting" && (
						<Badge
							key={nudge}
							size="sm"
							variant="light"
							color={nudge > 0 ? "yellow" : "gray"}
							className={nudge > 0 ? "nf-outline-nudge" : undefined}
							data-testid="outline-connecting"
							data-nudge={nudge}
							title={client.provisional ? t("editor.connectingHint") : undefined}
						>
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
			<UnsavedTextsNotice pageId={pageId} client={client} />
			{deleted && (
				<Alert color="yellow" variant="light" py={6} data-testid="outline-deleted-notice">
					<Group gap="xs" wrap="wrap">
						<Text size="sm">
							{deleted.by
								? t("editor.deletedBy", { name: deleted.by })
								: t("editor.deletedBySomeone")}
						</Text>
						{client.editable && (
							<Button
								size="compact-xs"
								variant="light"
								onClick={() => {
									if (!client.restoreDeleted())
										notifications.show({
											color: "yellow",
											message: t("editor.restoreNotPossible"),
										});
								}}
							>
								{t("editor.restore")}
							</Button>
						)}
						<Button size="compact-xs" variant="subtle" onClick={() => client.dismissDeleted()}>
							{t("editor.dismiss")}
						</Button>
					</Group>
				</Alert>
			)}
			<div ref={frame} className="nf-outline-editor-host" data-testid="outline-frame" />
		</div>
	);
}
