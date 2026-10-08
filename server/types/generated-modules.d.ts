declare module "@server/generated/embedded-changelog" {
	export const embeddedChangelogs: ReadonlyArray<{
		version: string;
		date: string;
		en: string;
		"zh-CN": string;
	}>;
}

// Only the cross-platform release build generates this module. Normal source-checkout
// type checks still need the exact public shape used by the runtime fallback.
declare module "@server/generated/embedded-licenses" {
	export const embeddedLicenseEntries: readonly import("@server/lib/licenses/types").LicenseEntry[];
	export const embeddedLicenseTexts: Record<string, string>;
	export const embeddedLicenseProblems: readonly import("@server/lib/licenses/types").LicenseProblem[];
	export const embeddedLicenseGeneratedAt: number;
}

declare module "@server/generated/parcel-native-loader" {
	export function loadParcelNativeBinding(): Record<string, (...args: unknown[]) => unknown> | null;
}
