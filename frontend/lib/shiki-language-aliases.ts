/**
 * Shiki language alias map — build-time data, resolvable in every runtime.
 *
 * `getShikiLang()` and the highlighter's language loader both need one small
 * thing: a map from every language id/alias to its canonical grammar asset id
 * (332 entries, ~5.8KB of JSON). This module is the single source for it.
 *
 * WHY THIS FILE EXISTS AS A REAL MODULE
 *
 * The map used to be injected through a `virtual:shiki-language-aliases` module
 * that only Vite could resolve. Because `shiki-loader.ts` imported it at the top
 * level, every module that transitively reached the loader — including pure
 * geometry code in the narrator list — became unresolvable outside Vite. Six test
 * files paid for that: five carried a `mock.module("virtual:…")` workaround and
 * the sixth simply failed. A build-time constant table should never be the thing
 * that decides whether a module graph can be loaded.
 *
 * WHY THE VITE PLUGIN STILL REPLACES IT
 *
 * `bundledLanguagesInfo` (from `shiki/langs`) carries a `() => import(...)`
 * loader for every grammar. Shipping that registry to the browser makes
 * Vite/Rolldown treat hundreds of grammar chunks as dynamic dependencies and
 * preload them on the narrator route — exactly what the original virtual module
 * was introduced to avoid. So the Vite plugin `load()`s THIS path and swaps the
 * body for a precomputed literal, keeping `shiki/langs` out of the bundle.
 *
 * Net effect: identical browser output, but Bun, `tsgo` and the test runner can
 * all resolve this module for real.
 */

import { bundledLanguagesAlias, bundledLanguagesInfo } from "shiki/langs";
import { createShikiLanguageAliasMap } from "../build/shiki-language-aliases";
import type { ShikiLanguageAliasMap } from "./shiki-language-loader";

/**
 * Language id / alias (lowercased) → canonical grammar asset id.
 *
 * In a Vite build this declaration is replaced by an inlined object literal; the
 * computation below only runs outside Vite (tests, type checking, Bun scripts).
 */
export const SHIKI_LANGUAGE_ALIASES: ShikiLanguageAliasMap = createShikiLanguageAliasMap(
	bundledLanguagesInfo,
	bundledLanguagesAlias,
);
