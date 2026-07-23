import {
	type PretextLayoutAnchor,
	type PretextLayoutIndex,
	type PretextLayoutManifest,
	restorePretextLayoutAnchor,
} from "@shared/pretext-layout";
import type { NarratorMsg } from "../narrator-panel-types";
import type { RenderLod } from "./prepared-block";
import {
	type BuildPretextDocumentLayoutOptions,
	buildPretextDocumentLayout,
} from "./pretext-document-layout";
import {
	loadPretextDocument,
	type PretextDocumentInput,
	type PretextDocumentLoadOptions,
} from "./pretext-document-loader";
import type { VListItem } from "./vlist-pipeline";

export type PretextLayoutCoordinatorStatus = "idle" | "loading" | "computing" | "ready" | "error";

export interface PretextLayoutCoordinatorSnapshot {
	status: PretextLayoutCoordinatorStatus;
	input?: PretextDocumentInput;
	manifest?: PretextLayoutManifest;
	index?: PretextLayoutIndex;
	items?: readonly VListItem[];
	scrollTop?: number;
	scrollTopAnchorKind?: PretextLayoutAnchor["kind"];
	error?: Error;
}

export interface PretextLayoutBuildOptions
	extends Omit<BuildPretextDocumentLayoutOptions, "layoutRevision" | "documentRevision" | "lod"> {
	lod: RenderLod;
}

export class PretextLayoutCoordinator {
	private generation = 0;
	private input: PretextDocumentInput | undefined;
	private current: PretextLayoutCoordinatorSnapshot = { status: "idle" };
	private readonly listeners = new Set<() => void>();

	getSnapshot = (): PretextLayoutCoordinatorSnapshot => this.current;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	async load(
		narratorId: string,
		buildOptions: PretextLayoutBuildOptions,
		loadOptions: PretextDocumentLoadOptions = {},
		anchor?: PretextLayoutAnchor,
		viewportHeight = 0,
	): Promise<PretextLayoutCoordinatorSnapshot> {
		const generation = ++this.generation;
		this.current = { ...this.current, status: "loading", error: undefined };
		this.emit();
		try {
			const input = await loadPretextDocument(narratorId, loadOptions);
			if (generation !== this.generation) return this.current;
			this.input = input;
			return this.commitLayout(input, buildOptions, anchor, viewportHeight, generation);
		} catch (error) {
			if (generation !== this.generation) return this.current;
			this.current = {
				...this.current,
				status: "error",
				error: error instanceof Error ? error : new Error(String(error)),
			};
			this.emit();
			throw error;
		}
	}

	rebuild(
		buildOptions: PretextLayoutBuildOptions,
		anchor?: PretextLayoutAnchor,
		viewportHeight = 0,
	): PretextLayoutCoordinatorSnapshot {
		if (!this.input) throw new Error("cannot rebuild layout before document input is loaded");
		const generation = ++this.generation;
		this.current = { ...this.current, status: "computing", error: undefined };
		this.emit();
		return this.commitLayout(this.input, buildOptions, anchor, viewportHeight, generation);
	}

	cancel(): void {
		this.generation++;
	}

	reset(): void {
		this.generation++;
		this.input = undefined;
		this.current = { status: "idle" };
		this.emit();
	}

	private commitLayout(
		input: PretextDocumentInput,
		buildOptions: PretextLayoutBuildOptions,
		anchor: PretextLayoutAnchor | undefined,
		viewportHeight: number,
		generation: number,
	): PretextLayoutCoordinatorSnapshot {
		if (generation !== this.generation) return this.current;
		try {
			const built = buildPretextDocumentLayout(input.messages as unknown as NarratorMsg[], {
				...buildOptions,
				layoutRevision: `${input.messageVersion}:${buildOptions.widthBucket}:${buildOptions.lod}`,
				documentRevision: input.messageVersion,
			});
			if (generation !== this.generation) return this.current;
			const previous = this.current.index;
			let scrollTop: number | undefined;
			if (previous && anchor) {
				scrollTop = restorePretextLayoutAnchor(anchor, built.index, viewportHeight);
			}
			this.current = {
				status: "ready",
				input,
				manifest: built.manifest,
				index: built.index,
				items: built.items,
				...(scrollTop == null ? {} : { scrollTop, scrollTopAnchorKind: anchor?.kind ?? "item" }),
			};
			this.emit();
			return this.current;
		} catch (error) {
			this.current = {
				...this.current,
				status: "error",
				error: error instanceof Error ? error : new Error(String(error)),
			};
			this.emit();
			throw error;
		}
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}
