declare module "@server/generated/embedded-changelog" {
	export const embeddedChangelogs: ReadonlyArray<{
		version: string;
		date: string;
		en: string;
		"zh-CN": string;
	}>;
}

declare module "@server/generated/parcel-native-loader" {
	export function loadParcelNativeBinding(): Record<string, (...args: unknown[]) => unknown> | null;
}
