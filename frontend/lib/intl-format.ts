import { DEFAULT_LOCALE, type Locale, normalizeLocale } from "@shared/i18n-locales";

export type DateInput = Date | string | number;

export function resolveIntlLocale(locale?: string | null): Locale {
	if (locale) return normalizeLocale(locale);
	if (typeof document !== "undefined" && document.documentElement.lang) {
		return normalizeLocale(document.documentElement.lang);
	}
	if (typeof navigator !== "undefined" && navigator.language) {
		return normalizeLocale(navigator.language);
	}
	return DEFAULT_LOCALE;
}

export function formatLocaleNumber(
	value: number,
	options: Intl.NumberFormatOptions = {},
	locale?: string | null,
): string {
	return new Intl.NumberFormat(resolveIntlLocale(locale), options).format(value);
}

function toValidDate(value: DateInput): Date | undefined {
	let date: Date;
	if (typeof value === "string") {
		const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
		date = dateOnly
			? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
			: new Date(value);
	} else {
		date = value instanceof Date ? value : new Date(value);
	}
	return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatLocaleDateTime(
	value: DateInput,
	options?: Intl.DateTimeFormatOptions,
	locale?: string | null,
): string {
	const date = toValidDate(value);
	return date ? date.toLocaleString(resolveIntlLocale(locale), options) : "";
}

export function formatLocaleDate(
	value: DateInput,
	options?: Intl.DateTimeFormatOptions,
	locale?: string | null,
): string {
	const date = toValidDate(value);
	return date ? date.toLocaleDateString(resolveIntlLocale(locale), options) : "";
}

export function formatLocaleTime(
	value: DateInput,
	options?: Intl.DateTimeFormatOptions,
	locale?: string | null,
): string {
	const date = toValidDate(value);
	return date ? date.toLocaleTimeString(resolveIntlLocale(locale), options) : "";
}

export function formatLocaleRelativeTime(
	value: number,
	unit: Intl.RelativeTimeFormatUnit,
	options: Intl.RelativeTimeFormatOptions = {},
	locale?: string | null,
): string {
	return new Intl.RelativeTimeFormat(resolveIntlLocale(locale), options).format(value, unit);
}

/**
 * Message timestamp the way chat bubbles show it: today → HH:mm, otherwise
 * MM/DD HH:mm. Shared by the bubble headers and the scrollbar user-mark
 * tooltips so every surface renders the same turn the same way.
 */
export function formatShortMessageTime(value: DateInput, locale?: string | null): string {
	const date = toValidDate(value);
	if (!date) return "";
	const now = new Date();
	const isToday =
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate();
	return isToday
		? formatLocaleTime(date, { hour: "2-digit", minute: "2-digit" }, locale)
		: formatLocaleDateTime(
				date,
				{ month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" },
				locale,
			);
}
