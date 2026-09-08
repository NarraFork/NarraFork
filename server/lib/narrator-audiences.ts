import {
	clampWriteAudience,
	isWriteAudienceAllowed,
	type NarratorVisibility,
	type NarratorWriteAudience,
	widestWriteAudienceFor,
} from "@shared/narrator-access";
import { ValidationError } from "./errors";
import type { NarraForkSettings } from "./settings/types";

/** Invalid hand-edited settings retain the legacy creation behavior. */
export function normalizeDefaultNarratorVisibility(
	value: unknown,
): NarraForkSettings["agent"]["defaultNarratorVisibility"] {
	return value === "private" || value === "public" ? value : "auto";
}

/** Invalid hand-edited write defaults retain visibility-derived creation behavior. */
export function normalizeDefaultNarratorWriteAudience(
	value: unknown,
): NarraForkSettings["agent"]["defaultNarratorWriteAudience"] {
	return value === "owner" || value === "project" || value === "public" ? value : "auto";
}

/** Creation only: explicit audiences win; only global write defaults are clamped. */
export function resolveNarratorAudiences(
	visibility: NarratorVisibility | undefined,
	writeAudience: NarratorWriteAudience | undefined,
	chapterId: string | null | undefined,
	defaultVisibility: NarraForkSettings["agent"]["defaultNarratorVisibility"] = "auto",
	defaultWriteAudience: NarraForkSettings["agent"]["defaultNarratorWriteAudience"] = "auto",
): { visibility: NarratorVisibility; writeAudience: NarratorWriteAudience } {
	const configured = normalizeDefaultNarratorVisibility(defaultVisibility);
	const effectiveVisibility =
		visibility ?? (configured === "auto" ? (chapterId ? "project" : "private") : configured);
	const configuredWrite = normalizeDefaultNarratorWriteAudience(defaultWriteAudience);
	const effectiveWriteAudience =
		writeAudience ??
		(configuredWrite === "auto"
			? widestWriteAudienceFor(effectiveVisibility)
			: clampWriteAudience(effectiveVisibility, configuredWrite));
	if (!isWriteAudienceAllowed(effectiveVisibility, effectiveWriteAudience)) {
		throw new ValidationError(
			`Write audience "${effectiveWriteAudience}" is wider than visibility "${effectiveVisibility}"`,
		);
	}
	return { visibility: effectiveVisibility, writeAudience: effectiveWriteAudience };
}
