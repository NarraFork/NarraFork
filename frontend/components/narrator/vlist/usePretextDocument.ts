import type { TreeMessage } from "@frontend/lib/api/types";
import type {
	PretextLayoutAnchor,
	PretextLayoutIndex,
	PretextLayoutManifest,
} from "@shared/pretext-layout";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { NarratorMsg } from "../narrator-panel-types";
import type { RenderLod } from "./prepared-block";
import type { PretextDocumentLoadOptions } from "./pretext-document-loader";
import {
	type PretextLayoutBuildOptions,
	PretextLayoutCoordinator,
	type PretextLayoutCoordinatorSnapshot,
} from "./pretext-layout-coordinator";
import type { VListItem } from "./vlist-pipeline";

export interface UsePretextDocumentOptions {
	enabled?: boolean;
	lod: RenderLod;
	widthBucket: string | number;
	contentWidth: number;
	viewportHeight: number;
	gap?: number;
	topPadding?: number;
	bottomPadding?: number;
	isExpanded?: (key: string) => boolean | undefined;
	isLodUserOverride?: (key: string) => boolean;
	showEarlier?: (key: string) => boolean;
	expandedRows?: (key: string) => readonly number[];
	recentMessageIds?: ReadonlySet<string>;
	resolveRecentMessageIds?: (messages: readonly NarratorMsg[]) => ReadonlySet<string>;
	labels?: Record<string, string>;
	resolveToolCategory?: (toolName: string, input?: unknown) => string;
	resolveToolColor?: (toolName: string, input?: unknown) => string;
	scrollTop: number;
	pinnedToBottom: boolean;
	loadOptions?: PretextDocumentLoadOptions;
	onScrollTopCorrection?: (scrollTop: number, anchorKind: PretextLayoutAnchor["kind"]) => void;
}

export interface UsePretextDocumentResult {
	status: PretextLayoutCoordinatorSnapshot["status"];
	messages: readonly TreeMessage[];
	manifest?: PretextLayoutManifest;
	index?: PretextLayoutIndex;
	items: readonly VListItem[];
	scrollTopCorrection?: number;
	scrollTopCorrectionKind?: PretextLayoutAnchor["kind"];
	error?: Error;
	reload: () => void;
}

const EMPTY_MESSAGES: readonly TreeMessage[] = [];
const EMPTY_ITEMS: readonly VListItem[] = [];

export function shouldForcePretextDocumentLoad(
	reloadToken: number,
	handledReloadToken: number,
): boolean {
	return reloadToken > handledReloadToken;
}

export function usePretextDocument(
	narratorId: string,
	options: UsePretextDocumentOptions,
): UsePretextDocumentResult {
	const enabled = options.enabled !== false;
	const coordinator = useMemo(() => (enabled ? new PretextLayoutCoordinator() : null), [enabled]);
	const [reloadToken, setReloadToken] = useState(0);
	const handledReloadTokenRef = useRef(0);
	const previousNarratorRef = useRef<string | null>(null);
	const viewRef = useRef({
		scrollTop: options.scrollTop,
		viewportHeight: options.viewportHeight,
		pinnedToBottom: options.pinnedToBottom,
	});
	viewRef.current = {
		scrollTop: options.scrollTop,
		viewportHeight: options.viewportHeight,
		pinnedToBottom: options.pinnedToBottom,
	};
	const buildOptions = useMemo<PretextLayoutBuildOptions>(
		() => ({
			lod: options.lod,
			widthBucket: options.widthBucket,
			contentWidth: options.contentWidth,
			viewportHeight: options.viewportHeight,
			gap: options.gap ?? 4,
			topPadding: options.topPadding ?? 16,
			bottomPadding: options.bottomPadding ?? 16,
			isExpanded: options.isExpanded,
			isLodUserOverride: options.isLodUserOverride,
			showEarlier: options.showEarlier,
			expandedRows: options.expandedRows,
			recentMessageIds: options.recentMessageIds,
			resolveRecentMessageIds: options.resolveRecentMessageIds,
			labels: options.labels,
			resolveToolCategory: options.resolveToolCategory,
			resolveToolColor: options.resolveToolColor,
		}),
		[
			options.bottomPadding,
			options.contentWidth,
			options.expandedRows,
			options.gap,
			options.isExpanded,
			options.isLodUserOverride,
			options.labels,
			options.recentMessageIds,
			options.resolveRecentMessageIds,
			options.lod,
			options.resolveToolCategory,
			options.resolveToolColor,
			options.showEarlier,
			options.topPadding,
			options.viewportHeight,
			options.widthBucket,
		],
	);
	const snapshot = useSyncExternalStore(
		coordinator?.subscribe ?? (() => () => {}),
		coordinator?.getSnapshot ?? (() => ({ status: "idle" as const })),
		coordinator?.getSnapshot ?? (() => ({ status: "idle" as const })),
	);
	useEffect(() => {
		if (!coordinator) return;
		if (previousNarratorRef.current !== narratorId) {
			previousNarratorRef.current = narratorId;
			coordinator.reset();
		}
		const current = coordinator.getSnapshot();
		const anchor = current.index ? captureAnchor(current.index, viewRef.current) : undefined;
		const forceReload = shouldForcePretextDocumentLoad(reloadToken, handledReloadTokenRef.current);
		if (forceReload) handledReloadTokenRef.current = reloadToken;
		if (forceReload || current.status === "loading") {
			coordinator.cancel();
			void coordinator.load(
				narratorId,
				buildOptions,
				options.loadOptions,
				anchor,
				options.viewportHeight,
			);
			return () => coordinator.cancel();
		}
		if (current.input) coordinator.rebuild(buildOptions, anchor, options.viewportHeight);
		else
			void coordinator.load(
				narratorId,
				buildOptions,
				options.loadOptions,
				anchor,
				options.viewportHeight,
			);
		return () => coordinator.cancel();
	}, [
		buildOptions,
		coordinator,
		narratorId,
		options.loadOptions,
		options.viewportHeight,
		reloadToken,
	]);
	useEffect(() => {
		if (snapshot.scrollTop == null || !snapshot.scrollTopAnchorKind) return;
		options.onScrollTopCorrection?.(snapshot.scrollTop, snapshot.scrollTopAnchorKind);
	}, [options.onScrollTopCorrection, snapshot.scrollTop, snapshot.scrollTopAnchorKind]);
	const reload = useCallback(() => setReloadToken((value) => value + 1), []);
	return {
		status: snapshot.status,
		messages: snapshot.input?.messages ?? EMPTY_MESSAGES,
		manifest: snapshot.manifest,
		index: snapshot.index,
		items: snapshot.items ?? EMPTY_ITEMS,
		scrollTopCorrection: snapshot.scrollTop,
		scrollTopCorrectionKind: snapshot.scrollTopAnchorKind,
		error: snapshot.error,
		reload,
	};
}

function captureAnchor(
	index: PretextLayoutIndex,
	view: { scrollTop: number; viewportHeight: number; pinnedToBottom: boolean },
): PretextLayoutAnchor {
	if (view.pinnedToBottom) {
		return {
			kind: "bottom",
			distanceFromBottom: Math.max(
				0,
				index.totalHeight - view.scrollTop - Math.max(0, view.viewportHeight),
			),
		};
	}
	if (index.itemStarts.length > 0 && view.scrollTop < index.itemStart(0)) {
		return { kind: "item", itemKey: "", offsetWithinItem: 0, fallbackIndex: -1 };
	}
	const itemIndex = index.itemIndexAtOffset(view.scrollTop);
	if (itemIndex < 0) return { kind: "item", itemKey: "", offsetWithinItem: 0, fallbackIndex: -1 };
	return {
		kind: "item",
		itemKey: index.manifest.items[itemIndex]?.itemKey ?? "",
		offsetWithinItem: Math.max(0, view.scrollTop - index.itemStart(itemIndex)),
		fallbackIndex: itemIndex,
	};
}
