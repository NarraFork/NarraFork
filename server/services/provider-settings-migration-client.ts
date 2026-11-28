import {
	type ConnectedWorker,
	compiledWorkerSpecifiers,
	connectCompiledWorker,
} from "@server/lib/compiled-worker";
import { AppError } from "@server/lib/errors";
import { hotSafe } from "@server/lib/hot-safe";
import { TaskQueue } from "@server/lib/worker-runtime/queue";
import type { ProviderSettingsContribution } from "@shared/provider-settings";
import { providerSettingsSaveSchema } from "@shared/provider-settings-values";
import { type PluginSettingMutation, prepareSettingMutation } from "./plugin-settings-store";
import type { ProviderSettingsConfigContext } from "./provider-settings-config-policy";

const owner = hotSafe("narrafork.providerSettingsMigration.owner", () => ({
	queue: new TaskQueue({ concurrency: 1, maxQueued: 16, maxQueuedBytes: 1024 * 1024 }),
	workers: new Set<ConnectedWorker>(),
	shutdown: new AbortController(),
	closing: false,
}));
function failed(): AppError {
	return new AppError(
		"Provider settings migration could not be prepared",
		503,
		"PROVIDER_SETTINGS_MIGRATION_UNAVAILABLE",
	);
}
export async function prepareProviderSettingsMigration(
	context: ProviderSettingsConfigContext,
	declaration: ProviderSettingsContribution,
	raw: unknown,
	signal?: AbortSignal,
): Promise<PluginSettingMutation> {
	const request = providerSettingsSaveSchema.safeParse(raw);
	if (!request.success || owner.closing) throw failed();
	const input = { context, declaration, request: request.data },
		bytes = Buffer.byteLength(JSON.stringify(input));
	if (bytes > 96 * 1024) throw failed();
	const deadlineAt = Date.now() + 10000,
		permit = await owner.queue.acquire({
			bytes,
			deadlineAt,
			signal: signal ? AbortSignal.any([signal, owner.shutdown.signal]) : owner.shutdown.signal,
		});
	let connection: ConnectedWorker | undefined;
	try {
		if (owner.closing) throw failed();
		connection = await connectCompiledWorker(
			compiledWorkerSpecifiers(
				"services/provider-settings-migration-worker.ts",
				"./provider-settings-migration-worker.ts",
				import.meta.url,
			),
			{ deadlineAt, signal: permit.signal },
		);
		owner.workers.add(connection);
		const worker = connection.worker;
		return await new Promise<PluginSettingMutation>((resolve, reject) => {
			const fail = () => {
					cleanup();
					reject(failed());
				},
				timer = setTimeout(fail, Math.max(1, deadlineAt - Date.now()));
			const cleanup = () => {
				clearTimeout(timer);
				permit.signal.removeEventListener("abort", fail);
				worker.off("message", receive);
				worker.off("error", fail);
				worker.off("exit", fail);
			};
			const receive = (raw: unknown) => {
				try {
					const result = raw as { ok?: boolean; mutation?: PluginSettingMutation };
					if (!result?.ok || !result.mutation) throw failed();
					const mutation = prepareSettingMutation(result.mutation);
					if (
						mutation.address.pluginId !== context.pluginId ||
						mutation.address.contributionId !== declaration.id ||
						mutation.address.targetKind !== context.target?.kind ||
						mutation.address.targetId !== context.target.id ||
						mutation.value.installationId !== context.installationId
					)
						throw failed();
					cleanup();
					resolve(mutation);
				} catch {
					cleanup();
					fail();
				}
			};
			worker.once("message", receive);
			worker.once("error", fail);
			worker.once("exit", fail);
			permit.signal.addEventListener("abort", fail, { once: true });
			if (permit.signal.aborted) {
				cleanup();
				fail();
				return;
			}
			worker.postMessage(input);
		});
	} finally {
		if (connection) {
			await connection.handle.close();
			owner.workers.delete(connection);
		}
		permit.release();
	}
}
export async function closeProviderSettingsMigrations(): Promise<void> {
	owner.closing = true;
	owner.shutdown.abort(failed());
	const drained = owner.queue.close();
	await Promise.all([...owner.workers].map((worker) => worker.handle.close()));
	await drained;
}
