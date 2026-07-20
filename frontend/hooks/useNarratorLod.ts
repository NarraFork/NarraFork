import { useCallback, useState } from "react";
import {
	clampRenderLod,
	DEFAULT_RENDER_LOD,
	MAX_RENDER_LOD,
	MIN_RENDER_LOD,
	type RenderLod,
} from "../components/narrator/RenderLodCtx";

const DEFAULT_KEY = "narrafork_lod_default";
const storageKey = (narratorId: string) => `narrafork_lod:${narratorId}`;

/** Read the global default LOD (set via "set as default"; used by new narrators). */
function readDefaultLod(): RenderLod {
	try {
		const raw = localStorage.getItem(DEFAULT_KEY);
		if (raw === null) return DEFAULT_RENDER_LOD;
		const parsed = Number.parseInt(raw, 10);
		if (Number.isNaN(parsed)) return DEFAULT_RENDER_LOD;
		return clampRenderLod(parsed);
	} catch {
		return DEFAULT_RENDER_LOD;
	}
}

/**
 * Resolve a narrator's opening level: its own remembered level if it has one,
 * otherwise the global default. Per-narrator memory takes precedence so a
 * narrator the user has tuned keeps its level across reopen/switch.
 */
function readOpeningLod(narratorId: string | undefined): RenderLod {
	if (narratorId) {
		try {
			const raw = localStorage.getItem(storageKey(narratorId));
			if (raw !== null) {
				const parsed = Number.parseInt(raw, 10);
				if (!Number.isNaN(parsed)) return clampRenderLod(parsed);
			}
		} catch {
			// fall through to default
		}
	}
	return readDefaultLod();
}

export interface NarratorLod {
	lod: RenderLod;
	/** Whether the current level equals the saved global default. */
	isDefault: boolean;
	setLod: (value: RenderLod | ((prev: RenderLod) => RenderLod)) => void;
	/** More detail (L → L+1, capped at the max). */
	stepUp: () => void;
	/** Less detail (L → L-1, floored at the min). */
	stepDown: () => void;
	/** Save the current level as the global default (used by new narrators). */
	setAsDefault: () => void;
}

/**
 * Render detail level.
 *
 * Model (per product decision):
 *  - Each narrator remembers its own level (`narrafork_lod:<id>`) — gesture
 *    switches write through, so the level survives reopen/switch.
 *  - A global default (`narrafork_lod_default`) is written ONLY by an explicit
 *    "set as default" action and is used as the opening level for narrators
 *    that have no remembered level of their own.
 */
export function useNarratorLod(narratorId: string | undefined): NarratorLod {
	const [lod, setLodState] = useState<RenderLod>(() => readOpeningLod(narratorId));
	// Track the saved default so the toast offers "set as default" only when the
	// current level differs from it.
	const [defaultLod, setDefaultLod] = useState<RenderLod>(() => readDefaultLod());

	const setLod = useCallback(
		(value: RenderLod | ((prev: RenderLod) => RenderLod)) => {
			setLodState((prev) => {
				const resolved = clampRenderLod(typeof value === "function" ? value(prev) : value);
				if (narratorId) {
					try {
						localStorage.setItem(storageKey(narratorId), String(resolved));
					} catch {
						// ignore
					}
				}
				return resolved;
			});
		},
		[narratorId],
	);

	const stepUp = useCallback(() => {
		setLod((prev) => clampRenderLod(Math.min(MAX_RENDER_LOD, prev + 1)));
	}, [setLod]);

	const stepDown = useCallback(() => {
		setLod((prev) => clampRenderLod(Math.max(MIN_RENDER_LOD, prev - 1)));
	}, [setLod]);

	const setAsDefault = useCallback(() => {
		setLodState((current) => {
			try {
				localStorage.setItem(DEFAULT_KEY, String(current));
			} catch {
				// ignore
			}
			setDefaultLod(current);
			return current;
		});
	}, []);

	return { lod, isDefault: lod === defaultLod, setLod, stepUp, stepDown, setAsDefault };
}
