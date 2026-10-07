/**
 * localize-danger-copy.ts — Display-time localization for DangerInfo copy.
 *
 * Server classifiers write canonical English into summary / consequences /
 * saferAlternatives / details. This helper re-labels known system chrome through
 * i18n and leaves custom content untouched.
 */

import { lookupDangerCopy, lookupDangerDetail } from "@shared/danger-copy";

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function localizeDangerText(text: string, t: Translate): string {
	const ref = lookupDangerCopy(text) ?? lookupDangerDetail(text);
	if (!ref) return text;
	return t(ref.key, { ...ref.params, defaultValue: text });
}

export function localizeDangerDetailText(text: string, t: Translate): string {
	const ref = lookupDangerDetail(text) ?? lookupDangerCopy(text);
	if (!ref) return text;
	return t(ref.key, { ...ref.params, defaultValue: text });
}

export function localizeDangerTexts(items: readonly string[], t: Translate): string[] {
	return items.map((item) => localizeDangerText(item, t));
}
