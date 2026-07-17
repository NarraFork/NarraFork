import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import { AppError, NotFoundError, ValidationError } from "@server/lib/errors";
import { getNarraforkPath } from "@server/lib/narrafork-home";
import {
	type Manifest,
	manifestPathSchema,
	pluginIdSchema,
	safeParseManifest,
} from "@server/lib/plugins/manifest";
import { pluginPackageHashPattern, pluginPackageVersionPattern } from "./plugin-package-store";

export const DEFAULT_PLUGIN_UI_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PLUGIN_UI_SHELL_MAX_BYTES = 64 * 1024;

const MIME_TYPES: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".gif": "image/gif",
	".html": "text/html; charset=utf-8",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff": "font/woff",
	".woff2": "font/woff2",
};

export interface PluginUiAsset {
	pluginId: string;
	version: string;
	hash: string;
	path: string;
	bytes: Uint8Array;
	contentType: string;
}

export interface PluginUiPackage {
	pluginId: string;
	version: string;
	hash: string;
	packagePath: string;
	manifest: Manifest;
}

export interface PluginUiAssetServiceOptions {
	root?: string;
	maxAssetBytes?: number;
	maxManifestBytes?: number;
	maxShellBytes?: number;
}

function contained(root: string, candidate: string): boolean {
	const remainder = relative(resolve(root), resolve(candidate));
	return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

function assertSegment(value: string, label: string, pattern: RegExp): void {
	if (!pattern.test(value) || value.includes("/") || value.includes("\\") || value.includes("\0")) {
		throw new ValidationError(`Invalid ${label}`);
	}
}

function assertAssetPath(value: string): string {
	const parsed = manifestPathSchema.safeParse(value);
	if (!parsed.success) throw new ValidationError("Invalid plugin UI asset path");
	if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
		throw new ValidationError("Plugin UI asset path traversal is not allowed");
	}
	return value;
}

function contentType(path: string): string {
	return (
		MIME_TYPES[basename(path).slice(basename(path).lastIndexOf(".")).toLowerCase()] ??
		"application/octet-stream"
	);
}

function escapeAttribute(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[character];
	});
}

export class PluginUiAssetService {
	readonly packagesRoot: string;
	readonly maxAssetBytes: number;
	readonly maxManifestBytes: number;
	readonly maxShellBytes: number;

	constructor(options: PluginUiAssetServiceOptions = {}) {
		const root = resolve(options.root ?? getNarraforkPath("plugins"));
		this.packagesRoot = join(root, "packages");
		this.maxAssetBytes = options.maxAssetBytes ?? DEFAULT_PLUGIN_UI_ASSET_MAX_BYTES;
		this.maxManifestBytes = options.maxManifestBytes ?? 1024 * 1024;
		this.maxShellBytes = options.maxShellBytes ?? DEFAULT_PLUGIN_UI_SHELL_MAX_BYTES;
	}

	packagePath(pluginId: string, version: string, hash: string): string {
		if (!pluginIdSchema.safeParse(pluginId).success) throw new ValidationError("Invalid pluginId");
		assertSegment(version, "version", pluginPackageVersionPattern);
		assertSegment(hash, "hash", pluginPackageHashPattern);
		return join(this.packagesRoot, pluginId, version, hash);
	}

	async inspectPackage(pluginId: string, version: string, hash: string): Promise<PluginUiPackage> {
		const packagePath = this.packagePath(pluginId, version, hash);
		const packageInfo = await lstat(packagePath).catch(() => undefined);
		if (!packageInfo?.isDirectory() || packageInfo.isSymbolicLink()) {
			throw new NotFoundError("Plugin package", `${pluginId}@${version}`);
		}
		const packageReal = await realpath(packagePath);
		const packagesReal = await realpath(this.packagesRoot);
		if (!contained(packagesReal, packageReal))
			throw new AppError("Plugin package path escapes store", 422, "PLUGIN_PATH_ESCAPE");
		const manifestPath = join(packagePath, "manifest.json");
		const manifestInfo = await lstat(manifestPath);
		if (
			!manifestInfo.isFile() ||
			manifestInfo.isSymbolicLink() ||
			manifestInfo.size > this.maxManifestBytes
		) {
			throw new AppError("Plugin manifest is unavailable", 422, "PLUGIN_MANIFEST_UNAVAILABLE");
		}
		const manifestReal = await realpath(manifestPath);
		if (!contained(packageReal, manifestReal))
			throw new AppError("Plugin manifest escapes package", 422, "PLUGIN_PATH_ESCAPE");
		const manifestBytes = await readFile(manifestPath);
		if (manifestBytes.byteLength > this.maxManifestBytes)
			throw new AppError("Plugin manifest is too large", 422, "PLUGIN_MANIFEST_TOO_LARGE");
		let raw: unknown;
		try {
			raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
		} catch {
			throw new AppError("Plugin manifest is corrupt", 422, "PLUGIN_MANIFEST_CORRUPT");
		}
		const parsed = safeParseManifest(raw);
		if (!parsed.success || parsed.data.pluginId !== pluginId || parsed.data.version !== version) {
			throw new AppError("Plugin manifest identity is invalid", 422, "PLUGIN_IDENTITY_MISMATCH");
		}
		if (!parsed.data.ui)
			throw new AppError("Plugin has no UI contribution", 404, "PLUGIN_UI_UNAVAILABLE");
		return { pluginId, version, hash, packagePath, manifest: parsed.data };
	}

	async readAsset(
		pluginId: string,
		version: string,
		hash: string,
		assetPath: string,
	): Promise<PluginUiAsset> {
		const pkg = await this.inspectPackage(pluginId, version, hash);
		const safePath = assertAssetPath(assetPath);
		const declaredAssets = new Set<string>();
		if (pkg.manifest.ui?.entry) declaredAssets.add(pkg.manifest.ui.entry);
		if (pkg.manifest.ui?.style) declaredAssets.add(pkg.manifest.ui.style);
		for (const view of pkg.manifest.contributes.views) {
			declaredAssets.add(view.entry);
			if (view.style) declaredAssets.add(view.style);
		}
		if (!declaredAssets.has(safePath)) throw new NotFoundError("Plugin UI asset", safePath);
		const filePath = resolve(pkg.packagePath, ...safePath.split("/"));
		if (!contained(pkg.packagePath, filePath))
			throw new ValidationError("Plugin UI asset escapes package");
		const info = await lstat(filePath).catch(() => undefined);
		if (!info?.isFile() || info.isSymbolicLink())
			throw new NotFoundError("Plugin UI asset", safePath);
		const fileReal = await realpath(filePath);
		const packageReal = await realpath(pkg.packagePath);
		if (!contained(packageReal, fileReal))
			throw new AppError("Plugin UI asset escapes package", 422, "PLUGIN_PATH_ESCAPE");
		if (info.size > this.maxAssetBytes)
			throw new AppError("Plugin UI asset exceeds size limit", 413, "PLUGIN_UI_ASSET_TOO_LARGE");
		const bytes = await readFile(filePath);
		if (bytes.byteLength > this.maxAssetBytes)
			throw new AppError("Plugin UI asset exceeds size limit", 413, "PLUGIN_UI_ASSET_TOO_LARGE");
		return { pluginId, version, hash, path: safePath, bytes, contentType: contentType(safePath) };
	}

	async shell(
		pluginId: string,
		version: string,
		hash: string,
		sessionId: string,
		assetToken: string,
	): Promise<string> {
		const pkg = await this.inspectPackage(pluginId, version, hash);
		const ui = pkg.manifest.ui;
		if (!ui) throw new NotFoundError("Plugin UI", pluginId);
		const assetUrl = escapeAttribute(
			`/api/plugins/ui/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/${encodeURIComponent(hash)}/asset/${encodeURIComponent(sessionId)}/${ui.entry}?sessionToken=${encodeURIComponent(assetToken)}`,
		);
		const style = ui.style
			? `<link rel="stylesheet" href="${escapeAttribute(`/api/plugins/ui/${encodeURIComponent(pluginId)}/${encodeURIComponent(version)}/${encodeURIComponent(hash)}/asset/${encodeURIComponent(sessionId)}/${ui.style}?sessionToken=${encodeURIComponent(assetToken)}`)}">`
			: "";
		const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">${style}</head><body><div id="narrafork-plugin-root"></div><script src="${assetUrl}" defer></script></body></html>`;
		if (Buffer.byteLength(html, "utf8") > this.maxShellBytes)
			throw new AppError("Plugin UI shell exceeds size limit", 413, "PLUGIN_UI_SHELL_TOO_LARGE");
		return html;
	}
}

export const pluginUiAssetService = new PluginUiAssetService();
