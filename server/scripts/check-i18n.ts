import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from "../../shared/i18n-locales";

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

type FlatResources = Map<string, string>;

interface LocaleResources {
	bytes: number;
	namespaces: Map<string, FlatResources>;
}

export interface I18nLocaleStats {
	locale: Locale;
	namespaceCount: number;
	keyCount: number;
	bytes: number;
	coverage: number;
}

export interface I18nCheckReport {
	errors: string[];
	warnings: string[];
	stats: I18nLocaleStats[];
}

function flattenResources(
	value: unknown,
	prefix: string,
	output: FlatResources,
	errors: string[],
	location: string,
): void {
	if (typeof value === "string") {
		if (!prefix) errors.push(`${location}: root value must be an object`);
		else output.set(prefix, value);
		return;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		errors.push(`${location}: ${prefix || "<root>"} must be a string or object`);
		return;
	}
	for (const [key, child] of Object.entries(value)) {
		flattenResources(child, prefix ? `${prefix}.${key}` : key, output, errors, location);
	}
}

function readLocaleResources(
	localesDir: string,
	locale: Locale,
	errors: string[],
): LocaleResources | undefined {
	const localeDir = join(localesDir, locale);
	let files: string[];
	try {
		files = readdirSync(localeDir)
			.filter((name) => name.endsWith(".json"))
			.sort();
	} catch {
		errors.push(`${locale}: locale directory is missing`);
		return undefined;
	}

	const namespaces = new Map<string, FlatResources>();
	let bytes = 0;
	for (const file of files) {
		const path = join(localeDir, file);
		const location = `${locale}/${file}`;
		try {
			const source = readFileSync(path, "utf8");
			bytes += statSync(path).size;
			const flattened: FlatResources = new Map();
			flattenResources(JSON.parse(source), "", flattened, errors, location);
			namespaces.set(file.slice(0, -5), flattened);
		} catch (error) {
			errors.push(`${location}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { bytes, namespaces };
}

function pluralKeyParts(key: string): { root: string; category: string } | undefined {
	const match = key.match(PLURAL_SUFFIX);
	if (!match || match.index === undefined) return undefined;
	return { root: key.slice(0, match.index), category: match[1] };
}

function interpolationVariables(value: string): string[] {
	const variables = new Set<string>();
	for (const match of value.matchAll(/\{\{\s*-?\s*([\p{L}\p{N}_.-]+)/gu)) {
		if (match[1]) variables.add(match[1]);
	}
	return [...variables].sort();
}

function checkInterpolation(
	baseValue: string,
	targetValue: string,
	label: string,
	errors: string[],
	allowRenamedVariables = false,
): void {
	const baseVariables = interpolationVariables(baseValue);
	const targetVariables = interpolationVariables(targetValue);
	if (allowRenamedVariables && baseVariables.length === targetVariables.length) return;
	if (baseVariables.join("\0") !== targetVariables.join("\0")) {
		errors.push(
			`${label}: interpolation variables differ (${baseVariables.join(", ") || "none"} vs ${targetVariables.join(", ") || "none"})`,
		);
	}
}

function basePluralTemplate(
	base: FlatResources,
	root: string,
	category: string,
): string | undefined {
	return (
		base.get(`${root}_${category}`) ??
		base.get(`${root}_other`) ??
		base.get(root) ??
		[...base.entries()].find(([key]) => pluralKeyParts(key)?.root === root)?.[1]
	);
}

function compareNamespace(
	base: FlatResources,
	target: FlatResources,
	locale: Locale,
	namespace: string,
	errors: string[],
	warnings: string[],
): { translatedUnits: number; totalUnits: number } {
	const pluralFamilies = new Map<string, Set<string>>();
	for (const key of base.keys()) {
		const parts = pluralKeyParts(key);
		if (!parts) continue;
		const categories = pluralFamilies.get(parts.root) ?? new Set<string>();
		categories.add(parts.category);
		pluralFamilies.set(parts.root, categories);
	}
	for (const [root, categories] of pluralFamilies) {
		if (categories.size < 2 && !base.has(root)) pluralFamilies.delete(root);
	}

	const simpleKeys = [...base.keys()].filter((key) => {
		const parts = pluralKeyParts(key);
		if (parts && pluralFamilies.has(parts.root)) return false;
		return !pluralFamilies.has(key);
	});
	let translatedUnits = 0;

	for (const key of simpleKeys) {
		const targetValue = target.get(key);
		if (targetValue === undefined) {
			errors.push(`${locale}/${namespace}: missing key ${key}`);
			continue;
		}
		translatedUnits++;
		checkInterpolation(
			base.get(key) ?? "",
			targetValue,
			`${locale}/${namespace}:${key}`,
			errors,
			/(placeholder|example|syntax)/i.test(key),
		);
	}

	const requiredCategories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
	for (const root of pluralFamilies.keys()) {
		const genericTarget = target.get(root);
		if (genericTarget !== undefined) {
			translatedUnits++;
			checkInterpolation(
				basePluralTemplate(base, root, "other") ?? "",
				genericTarget,
				`${locale}/${namespace}:${root}`,
				errors,
			);
			continue;
		}

		const missingCategories = requiredCategories.filter(
			(category) => !target.has(`${root}_${category}`),
		);
		if (missingCategories.length > 0) {
			errors.push(
				`${locale}/${namespace}: plural key ${root} is missing ${missingCategories.join(", ")}`,
			);
			continue;
		}

		translatedUnits++;
		for (const category of requiredCategories) {
			const targetValue = target.get(`${root}_${category}`);
			if (targetValue === undefined) continue;
			checkInterpolation(
				basePluralTemplate(base, root, category) ?? "",
				targetValue,
				`${locale}/${namespace}:${root}_${category}`,
				errors,
			);
		}
	}

	const knownRoots = new Set(pluralFamilies.keys());
	const extraKeys = [...target.keys()].filter((key) => {
		if (base.has(key)) return false;
		const parts = pluralKeyParts(key);
		return !parts || !knownRoots.has(parts.root);
	});
	if (extraKeys.length > 0) {
		const preview = extraKeys.slice(0, 10).join(", ");
		warnings.push(
			`${locale}/${namespace}: ${extraKeys.length} extra key(s): ${preview}${extraKeys.length > 10 ? ", ..." : ""}`,
		);
	}

	return {
		translatedUnits,
		totalUnits: simpleKeys.length + pluralFamilies.size,
	};
}

const DEFAULT_LOCALE_FORMAT_PATTERNS = [
	/\.toLocale(?:String|DateString|TimeString)\(\s*(?:\)|undefined\b|\[\s*\])/g,
	/new\s+Intl\.(?:NumberFormat|DateTimeFormat|RelativeTimeFormat)\(\s*undefined\b/g,
];

function collectSourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...collectSourceFiles(path));
		else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path);
	}
	return files;
}

export function checkLocaleSensitiveFormatting(frontendDir: string): string[] {
	const errors: string[] = [];
	for (const path of collectSourceFiles(frontendDir)) {
		const file = relative(frontendDir, path);
		if (
			file === "lib/intl-format.ts" ||
			/(?:^|\/)__tests__\//.test(file) ||
			/\.test\./.test(file)
		) {
			continue;
		}
		const source = readFileSync(path, "utf8");
		for (const pattern of DEFAULT_LOCALE_FORMAT_PATTERNS) {
			pattern.lastIndex = 0;
			for (const match of source.matchAll(pattern)) {
				const line = source.slice(0, match.index).split("\n").length;
				errors.push(
					`${file}:${line}: locale-sensitive formatting must use frontend/lib/intl-format`,
				);
			}
		}
	}
	return errors;
}

export function checkI18nResources(
	localesDir = resolve(import.meta.dir, "..", "..", "frontend", "locales"),
	frontendDir = resolve(localesDir, ".."),
): I18nCheckReport {
	const errors: string[] = [...checkLocaleSensitiveFormatting(frontendDir)];
	const warnings: string[] = [];
	const resources = new Map<Locale, LocaleResources>();

	for (const locale of SUPPORTED_LOCALES) {
		const loaded = readLocaleResources(localesDir, locale, errors);
		if (loaded) resources.set(locale, loaded);
	}

	const baseResources = resources.get(DEFAULT_LOCALE);
	if (!baseResources) return { errors, warnings, stats: [] };

	let directoryNames: string[] = [];
	try {
		directoryNames = readdirSync(localesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		errors.push(`Unable to read locale root: ${localesDir}`);
	}
	for (const directory of directoryNames) {
		if (!SUPPORTED_LOCALES.includes(directory as Locale)) {
			warnings.push(`Unsupported locale directory: ${directory}`);
		}
	}

	const stats: I18nLocaleStats[] = [];
	for (const locale of SUPPORTED_LOCALES) {
		const localeResources = resources.get(locale);
		if (!localeResources) continue;
		let translatedUnits = 0;
		let totalUnits = 0;

		for (const [namespace, base] of baseResources.namespaces) {
			const target = localeResources.namespaces.get(namespace);
			if (!target) {
				errors.push(`${locale}: missing namespace ${namespace}.json`);
				continue;
			}
			const result = compareNamespace(base, target, locale, namespace, errors, warnings);
			translatedUnits += result.translatedUnits;
			totalUnits += result.totalUnits;
		}

		for (const namespace of localeResources.namespaces.keys()) {
			if (!baseResources.namespaces.has(namespace)) {
				warnings.push(`${locale}: extra namespace ${namespace}.json`);
			}
		}

		const keyCount = [...localeResources.namespaces.values()].reduce(
			(total, namespace) => total + namespace.size,
			0,
		);
		stats.push({
			locale,
			namespaceCount: localeResources.namespaces.size,
			keyCount,
			bytes: localeResources.bytes,
			coverage: totalUnits === 0 ? 100 : (translatedUnits / totalUnits) * 100,
		});
	}

	return { errors, warnings, stats };
}

if (import.meta.main) {
	const report = checkI18nResources();
	for (const stat of report.stats) {
		console.log(
			`${stat.locale}: namespaces=${stat.namespaceCount}, keys=${stat.keyCount}, bytes=${stat.bytes}, coverage=${stat.coverage.toFixed(2)}%`,
		);
	}
	for (const warning of report.warnings) console.warn(`WARN: ${warning}`);
	for (const error of report.errors) console.error(`ERROR: ${error}`);
	if (report.errors.length > 0) process.exitCode = 1;
}
