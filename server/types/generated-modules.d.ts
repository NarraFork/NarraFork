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

// 构建脚本生成的嵌入前端资源表：URL 路径 → 编译产物内的文件路径（$bunfs）。
// 开发模式未构建前端时该模块不存在，读取方需要容忍 import 失败。
declare module "@server/generated/embedded-frontend" {
	export const embeddedAssets: Record<string, string>;
}
