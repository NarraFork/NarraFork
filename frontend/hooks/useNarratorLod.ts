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

/**
 * Schema version of the stored level numbers.
 *
 * v1 was a 1..6 scale. v2 dropped the old L3 (the "tool calls ×N summary block"
 * level, which read as neither folded nor detailed) and renumbered to 1..5.
 */
const SCHEMA_KEY = "narrafork_lod_schema";
const SCHEMA_VERSION = 2;

/**
 * Map a v1 (1..6) stored level onto the v2 (1..5) scale, preserving the SHAPE the
 * reader had chosen rather than the number:
 *
 *   6 → 5 (all cards expanded), 5 → 4 (recent expanded), 4 → 3 (all headers)
 *   3 → 3  the summary-block level is gone; "all headers" is its nearest survivor
 *   2 → 2, 1 → 1 (the merged activity fold is unchanged)
 *
 * Exported for the migration test; callers use `readOpeningLod`.
 */
export function migrateStoredLodV1(value: number): number {
	if (value >= 4) return value - 1;
	return value;
}

/**
 * Rewrite every stored level to the current schema, ONCE.
 *
 * Done eagerly (rather than mapping on each read) because the two scales overlap:
 * a stored `3` means the removed summary level under v1 and "all headers" under
 * v2, so nothing in the value itself says whether it has been migrated. The
 * schema marker is that record — and writing the mapped values back is what makes
 * the marker true, so `setAsDefault` cannot later mix scales.
 */
function migrateStoredLods(): void {
	try {
		if (localStorage.getItem(SCHEMA_KEY) === String(SCHEMA_VERSION)) return;
		const keys: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (key === DEFAULT_KEY || key?.startsWith("narrafork_lod:")) keys.push(key);
		}
		for (const key of keys) {
			const raw = localStorage.getItem(key);
			if (raw === null) continue;
			const parsed = Number.parseInt(raw, 10);
			if (Number.isNaN(parsed)) continue;
			localStorage.setItem(key, String(clampRenderLod(migrateStoredLodV1(parsed))));
		}
		localStorage.setItem(SCHEMA_KEY, String(SCHEMA_VERSION));
	} catch {
		// A storage-less environment simply reads the defaults below.
	}
}

/** Read the global default LOD (set via "set as default"; used by new narrators). */
function readDefaultLod(): RenderLod {
	migrateStoredLods();
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
 *
 * Exported so the stored-scale migration can be tested without a React tree: the
 * hook's only entry into it is this function, called from its state initializer.
 */
export function readOpeningLod(narratorId: string | undefined): RenderLod {
	migrateStoredLods();
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
