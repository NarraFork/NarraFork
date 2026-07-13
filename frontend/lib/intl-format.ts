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
