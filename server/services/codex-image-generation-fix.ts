/**
 * codex-image-generation-fix.ts — turn off the native `image_generation` tool for
 * ONE provider, addressed by the model prefix a failed turn actually ran on.
 *
 * Why a dedicated service instead of the generic settings PATCH: the tool flag
 * lives in different places depending on which adapter served the turn, and the
 * caller (an error card in the narrator timeline) only knows a model reference
 * like `codex:gpt-5.6-sol` or `myrelay:gpt-5.6-sol`.
 *
 *   - built-in Codex adapter  → `settings.codex.useImageGeneration`
 *   - custom API provider     → `customApiProviders[i].codexImageGeneration`
 *     (plus the derived `openaiProviders` mirror, which is what the provider
 *     factory actually reads)
 *
 * Resolution is by PREFIX, not by a client-supplied provider id, for the same
 * reason `fix-provider-baseurl` recomputes its target server-side: the request
 * carries an identifier, never the value to write.
 *
 * The decision (`planDisableCodexImageGeneration`) is a pure function of a
 * settings snapshot so it can be tested without touching the singleton or the
 * settings file; only the thin wrapper below reads and persists global state.
 *
 * Idempotent: disabling an already-disabled provider succeeds and reports
 * `changed: false`, so a double click (or a retry after a network hiccup) is
 * harmless.
 */

import { logger } from "../lib/logger";
import {
	customApiProvidersToAnthropic,
	customApiProvidersToGemini,
	customApiProvidersToOpenAI,
	deriveCustomApiProvidersFromLegacy,
	isOpenAICustomApiProtocol,
	type NarraForkSettings,
	saveSettings,
	settings,
} from "../lib/settings";

/** The built-in Codex adapter's reserved provider prefix. */
const BUILTIN_CODEX_PREFIX = "codex";

export type CodexImageGenerationTarget = "builtin-codex" | "custom-api-provider";

export interface CodexImageGenerationFixResult {
	/** Which settings location was written. */
	target: CodexImageGenerationTarget;
	/** The provider prefix that was resolved (echoed for the UI's message). */
	prefix: string;
	/** Display name of the provider whose flag was turned off. */
	providerName: string;
	/** False when image generation was already off (nothing was persisted). */
	changed: boolean;
}

/** Why a prefix could not be turned off, for a precise 4xx instead of a 500. */
export class CodexImageGenerationFixError extends Error {
	constructor(
		message: string,
		readonly reason: "unknown_provider" | "unsupported_protocol",
	) {
		super(message);
		this.name = "CodexImageGenerationFixError";
	}
}

/**
 * The planned outcome: what to report, plus the settings to persist when a change
 * is actually needed (`undefined` when the flag was already off).
 */
export interface CodexImageGenerationFixPlan {
	result: CodexImageGenerationFixResult;
	/** The settings object to save, or undefined when nothing changed. */
	next?: NarraForkSettings;
}

/** Extract the provider prefix from either a bare prefix or a `prefix:model` reference. */
export function providerPrefixFromModelRef(rawPrefix: string): string {
	const colon = rawPrefix.indexOf(":");
	return (colon > 0 ? rawPrefix.slice(0, colon) : rawPrefix).trim();
}

/**
 * Decide how to disable image generation for the provider behind `rawPrefix`,
 * against an explicit settings snapshot. Pure: returns the next settings instead
 * of writing them.
 */
export function planDisableCodexImageGeneration(
	current: NarraForkSettings,
	rawPrefix: string,
): CodexImageGenerationFixPlan {
	const prefix = providerPrefixFromModelRef(rawPrefix);
	if (!prefix) {
		throw new CodexImageGenerationFixError("A provider prefix is required.", "unknown_provider");
	}

	if (prefix === BUILTIN_CODEX_PREFIX) {
		const already = current.codex?.useImageGeneration === false;
		const result: CodexImageGenerationFixResult = {
			target: "builtin-codex",
			prefix,
			providerName: "Codex",
			changed: !already,
		};
		if (already) return { result };
		return {
			result,
			next: { ...current, codex: { ...(current.codex ?? {}), useImageGeneration: false } },
		};
	}

	const customApiProviders =
		current.customApiProviders ??
		deriveCustomApiProvidersFromLegacy(
			current.openaiProviders,
			current.anthropicProviders,
			current.geminiProviders,
		);
	const target = customApiProviders.find((provider) => provider.prefix === prefix);
	if (!target) {
		throw new CodexImageGenerationFixError(
			`No custom API provider uses the prefix "${prefix}".`,
			"unknown_provider",
		);
	}
	// Only the OpenAI-family protocols ever send Codex native tools; refusing the
	// rest keeps this from writing a flag that can never take effect.
	if (!isOpenAICustomApiProtocol(target.protocol)) {
		throw new CodexImageGenerationFixError(
			`Provider "${target.name || prefix}" does not use a Codex-compatible protocol.`,
			"unsupported_protocol",
		);
	}

	const providerName = target.name || prefix;
	if (target.codexImageGeneration === false) {
		return {
			result: { target: "custom-api-provider", prefix, providerName, changed: false },
		};
	}

	const nextCustomApiProviders = customApiProviders.map((provider) =>
		provider.id === target.id ? { ...provider, codexImageGeneration: false } : provider,
	);
	// Re-derive all three mirrors, exactly like the settings PATCH and
	// fix-provider-baseurl do: the provider factory reads `openaiProviders`.
	return {
		result: { target: "custom-api-provider", prefix, providerName, changed: true },
		next: {
			...current,
			customApiProviders: nextCustomApiProviders,
			openaiProviders: customApiProvidersToOpenAI(nextCustomApiProviders),
			anthropicProviders: customApiProvidersToAnthropic(nextCustomApiProviders),
			geminiProviders: customApiProvidersToGemini(nextCustomApiProviders),
		},
	};
}

/**
 * Disable the native image_generation tool for the provider behind `rawPrefix`
 * and persist the change.
 *
 * `rawPrefix` is the part before the colon in a model reference; a full reference
 * (`codex:gpt-5.6-sol`) is accepted and split here so callers can pass either.
 */
export function disableCodexImageGenerationForPrefix(
	rawPrefix: string,
): CodexImageGenerationFixResult {
	const { result, next } = planDisableCodexImageGeneration(settings, rawPrefix);
	if (next) {
		saveSettings(next);
		logger.info("Disabled Codex image generation", {
			target: result.target,
			prefix: result.prefix,
		});
	}
	return result;
}
