import { mock } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	defaultPluginSourceBinding,
	type PluginSource,
	type PluginSourceView,
	pluginSourceSchema,
} from "@shared/plugin-source";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { type LocalSourceDescriptor, PluginSourceFailure } from "../plugin-source-resolvers";
import {
	type PluginSourceApplyOptions,
	type PluginSourceInstallation,
	type PluginSourceManager,
	PluginSourceService,
	type PluginSourceServiceOptions,
} from "../plugin-source-service";
import { PluginSourceUpdateCache } from "../plugin-source-update-cache";

export const SOURCE_PLUGIN_ID = "io.example.plugin";
export const sourceWebsite = pluginSourceSchema.parse({
	type: "website",
	updateApi: "https://plugins.example/latest",
});
export const sourceBytes = new TextEncoder().encode("Source update test archive ".repeat(512));
export const sourceSha = Buffer.from(await crypto.subtle.digest("SHA-256", sourceBytes)).toString(
	"hex",
);

export class SourceTestManager implements PluginSourceManager {
	enabled = true;
	readonly states = new Map<string, PluginSourceInstallation>();
	readonly sources = new Map<string, PluginSourceView>();
	readonly listeners = new Set<(id: string) => void>();
	beforeCommit?: (options: PluginSourceApplyOptions) => Promise<void>;
	afterCommit?: (options: PluginSourceApplyOptions) => Promise<void>;

	constructor() {
		this.install(SOURCE_PLUGIN_ID, sourceWebsite);
	}
	install(id: string, source: PluginSource | null = sourceWebsite): void {
		this.states.set(id, {
			pluginId: id,
			installed: true,
			current: { version: "1.0.0", hash: "1".repeat(64) },
			installationId: crypto.randomUUID(),
			desiredState: "disabled",
		});
		this.sources.set(id, {
			pluginId: id,
			binding: { ...defaultPluginSourceBinding(), source },
			declaredSource: null,
			origin: source ? "configured" : "none",
			diagnostics: [],
		});
	}
	isEnabled() {
		return this.enabled;
	}
	getHostApiVersion() {
		return "1.0";
	}
	async getStatus(id: string) {
		const state = this.states.get(id);
		return state ? structuredClone(state) : undefined;
	}
	async listStatuses() {
		return [...this.states.values()].map((state) => structuredClone(state));
	}
	async getSource(id: string): Promise<PluginSourceView> {
		const view = this.sources.get(id);
		if (!view) throw new PluginSourceFailure("installation_changed");
		return structuredClone(view);
	}
	async setSource(id: string, source: PluginSource | null, options: { expectedRevision: number }) {
		const view = await this.getSource(id);
		if (view.binding.revision !== options.expectedRevision)
			throw new PluginSourceFailure("source_changed");
		view.binding = {
			revision: view.binding.revision + 1,
			mode: source ? "configured" : "none",
			source,
			autoUpdate: false,
		};
		view.origin = source ? "configured" : "none";
		this.sources.set(id, view);
		this.emit(id);
		return structuredClone(view);
	}
	async setAutoUpdate(id: string, autoUpdate: boolean, options: { expectedRevision: number }) {
		const view = await this.getSource(id);
		if (view.binding.revision !== options.expectedRevision)
			throw new PluginSourceFailure("source_changed");
		view.binding.autoUpdate = autoUpdate;
		view.binding.revision++;
		this.sources.set(id, view);
		this.emit(id);
		return structuredClone(view);
	}
	onSourceChanged(listener: (id: string) => void) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	emit(id: string) {
		for (const listener of this.listeners) listener(id);
	}
	uninstall(id: string) {
		this.states.delete(id);
		this.emit(id);
	}
	readonly updateFromSource = mock(async (path: string, options: PluginSourceApplyOptions) => {
		const state = this.states.get(options.pluginId);
		const view = this.sources.get(options.pluginId);
		if (
			!state?.current ||
			state.current.hash !== options.expectedCurrent.hash ||
			state.installationId !== options.expectedInstallationId
		)
			throw new PluginSourceFailure("installation_changed");
		if (view?.binding.revision !== options.expectedSourceRevision)
			throw new PluginSourceFailure("source_changed");
		expectArchive(await readFile(path));
		await this.beforeCommit?.(options);
		options.signal?.throwIfAborted();
		options.onCommit?.();
		await this.afterCommit?.(options);
		state.current = { version: options.expectedVersion, hash: "2".repeat(64) };
		return structuredClone(state);
	});
	readonly installBuiltin = mock(
		async (
			descriptor: LocalSourceDescriptor,
			options?: { signal?: AbortSignal; onCommit?: () => void },
		) => {
			if (this.states.get(descriptor.pluginId)?.installed)
				throw new PluginSourceFailure("installation_changed");
			options?.signal?.throwIfAborted();
			options?.onCommit?.();
			this.install(descriptor.pluginId, descriptor.source);
			const state = this.states.get(descriptor.pluginId);
			if (state) state.current = { version: descriptor.version, hash: "3".repeat(64) };
			return state;
		},
	);
}
function expectArchive(bytes: Uint8Array) {
	if (!bytes.byteLength) throw new PluginSourceFailure("size_mismatch");
}

export function sourceServiceFixture(root: string, overrides: PluginSourceServiceOptions = {}) {
	const manager = new SourceTestManager();
	let now = 1_000_000;
	let latestVersion = "1.2.3";
	const fetch = mock(async (url: string, _init?: RequestInit) => {
		if (new URL(url).pathname === "/latest")
			return Response.json({
				schemaVersion: 1,
				pluginId: new URL(url).searchParams.get("pluginId"),
				latest: {
					version: latestVersion,
					artifact: {
						url: "https://plugins.example/test.nfplugin",
						sha256: sourceSha,
						size: sourceBytes.byteLength,
					},
				},
			});
		return new Response(sourceBytes, {
			headers: { "content-length": String(sourceBytes.byteLength) },
		});
	});
	const local: LocalSourceDescriptor = {
		pluginId: "io.narrafork.provider-quota",
		version: "1.0.3",
		displayName: "Provider Quota",
		source: { type: "local", builtinId: "io.narrafork.provider-quota" },
		load: async () => ({ bytes: sourceBytes, sha256: sourceSha }),
	};
	const service = new PluginSourceService({
		manager,
		stagingRoot: root,
		summaries: new PluginSourceUpdateCache({
			filePath: getNarraforkPath(`plugin-update-test-summary-${crypto.randomUUID()}.json`),
		}),
		transport: () => ({ key: "public", isCurrent: () => true, fetch }),
		environment: () => ({ hostVersion: "0.9.14", hostApiVersion: "1.0", os: "win32", arch: "x64" }),
		now: () => now,
		random: () => 0,
		builtins: {
			get: (id) => (id === local.pluginId ? local : undefined),
			list: (installed = new Map()) => [
				{
					pluginId: local.pluginId,
					displayName: local.displayName,
					version: local.version,
					source: local.source,
					installed: installed.has(local.pluginId),
					installedVersion: installed.get(local.pluginId) ?? null,
					canInstall: !installed.has(local.pluginId),
				},
			],
		},
		...overrides,
	});
	return {
		service,
		manager,
		fetch,
		local,
		advance(ms: number) {
			now += ms;
		},
		latest(version: string) {
			latestVersion = version;
		},
	};
}
export function sourceDeferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
export async function sourceDrain() {
	for (let i = 0; i < 32; i++) await Promise.resolve();
}
