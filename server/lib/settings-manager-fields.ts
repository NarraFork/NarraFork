/**
 * 管理器直接写进 settings.json 的字段。
 *
 * 服务端 saveSettings 保存的是整份内存配置。若面板在这次保存之前改了监听地址或品牌，
 * 而服务内存里这些字段还是旧值，整份写回会把面板的修改盖掉。调用方记下上次加载到的值，
 * 磁盘上的新值只在服务自己没改这个字段时保留。
 */

export interface ManagerOwnedFields {
	host?: string;
	port?: number;
	openBrowser?: string;
	brandName?: string;
	brandColor?: string;
}

export interface ManagerFieldSettings {
	server: { host: string; port: number; openBrowser: "off" | "browser" | "app" };
	branding?: { name?: string; iconColor?: string };
}

export function readManagerOwnedFields(raw: unknown): ManagerOwnedFields {
	const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const server =
		record.server && typeof record.server === "object"
			? (record.server as Record<string, unknown>)
			: {};
	const branding =
		record.branding && typeof record.branding === "object"
			? (record.branding as Record<string, unknown>)
			: {};
	return {
		host: typeof server.host === "string" ? server.host : undefined,
		port: typeof server.port === "number" ? server.port : undefined,
		openBrowser: typeof server.openBrowser === "string" ? server.openBrowser : undefined,
		brandName: typeof branding.name === "string" ? branding.name : undefined,
		brandColor: typeof branding.iconColor === "string" ? branding.iconColor : undefined,
	};
}

export function managerFieldsFromSettings(settings: ManagerFieldSettings): ManagerOwnedFields {
	return {
		host: settings.server.host,
		port: settings.server.port,
		openBrowser: settings.server.openBrowser,
		brandName: settings.branding?.name,
		brandColor: settings.branding?.iconColor,
	};
}

export function preserveExternalManagerFields(
	next: ManagerFieldSettings,
	disk: ManagerOwnedFields,
	seen: ManagerOwnedFields,
): void {
	if (next.server.host === seen.host && disk.host !== undefined && disk.host !== seen.host) {
		next.server.host = disk.host;
	}
	if (next.server.port === seen.port && disk.port !== undefined && disk.port !== seen.port) {
		next.server.port = disk.port;
	}
	if (
		next.server.openBrowser === seen.openBrowser &&
		isOpenBrowser(disk.openBrowser) &&
		disk.openBrowser !== seen.openBrowser
	) {
		next.server.openBrowser = disk.openBrowser;
	}
	const memoryName = next.branding?.name ?? "";
	const seenName = seen.brandName ?? "";
	const diskName = disk.brandName ?? "";
	if (memoryName === seenName && diskName !== seenName) {
		next.branding = { ...next.branding };
		if (diskName) next.branding.name = diskName;
		else delete next.branding.name;
	}
	const memoryColor = next.branding?.iconColor ?? "";
	const seenColor = seen.brandColor ?? "";
	const diskColor = disk.brandColor ?? "";
	if (memoryColor === seenColor && diskColor !== seenColor) {
		next.branding = { ...next.branding };
		if (diskColor) next.branding.iconColor = diskColor;
		else delete next.branding.iconColor;
	}
}

function isOpenBrowser(value: string | undefined): value is "off" | "browser" | "app" {
	return value === "off" || value === "browser" || value === "app";
}
