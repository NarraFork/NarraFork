/**
 * 导出快照构建子进程。
 *
 * 只做一件事：从主库**只读**打开，把导入需要的表复制到一个新库里。
 * 放在独立进程是因为 `INSERT … SELECT` 与 `VACUUM` 是 O(数据量) 的同步操作，
 * 在主线程跑会卡住 HTTP/WS/Agent（bun:sqlite 是同步 API）。
 *
 * 不复制索引与触发器：导入只依赖主键与列集合；触发器若一并复制，导入时会重复写 FTS，
 * 而主库自己的触发器会负责维护搜索索引。
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BundleItem, sealBundle } from "../lib/credential-transfer/bundle";
import type { PluginSettingAddress } from "../services/plugin-settings-store";
import { openProviderSetting } from "../services/provider-settings-data";
import { createSqlitePluginSettingsStore } from "../services/sqlite-plugin-settings-store";
import {
	clearProviderSettingsData,
	type ProviderSettingsImportStageInput,
	prepareProviderSettingsImport,
} from "./provider-settings-import-stage";
import {
	DB_SNAPSHOT_KINDS_ENV,
	DB_SNAPSHOT_OUTPUT_ENV,
	DB_SNAPSHOT_SOURCE_ENV,
	PROVIDER_SETTINGS_SEALED_ENTRY,
	PROVIDER_SETTINGS_TRANSFER_LIMITS,
	SNAPSHOT_TABLES,
	type SnapshotBuildResult,
} from "./snapshot-protocol";

function selectedTables(): { all: string[]; copied: string[]; providers: boolean } {
	const raw = process.env[DB_SNAPSHOT_KINDS_ENV]?.trim();
	const kinds = raw ? new Set(raw.split(",").map((part) => part.trim())) : undefined;
	const requests = !kinds || kinds.has("requests"),
		sessions = !kinds || kinds.has("sessions"),
		providers = kinds?.has("providers") ?? false;
	const copied = [
		...(requests ? SNAPSHOT_TABLES.requests : []),
		...(sessions ? SNAPSHOT_TABLES.sessions : []),
		...(providers ? SNAPSHOT_TABLES.providers : []),
	];
	return {
		all: [
			...SNAPSHOT_TABLES.requests,
			...SNAPSHOT_TABLES.sessions,
			...(providers ? SNAPSHOT_TABLES.providers : []),
		],
		copied,
		providers,
	};
}

async function readPrivateInput(): Promise<unknown> {
	const reader = Bun.stdin.stream().getReader();
	let bytes = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > 256 * 1024) throw Error("Provider transfer input limit exceeded");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function providerInput(): Promise<{ passphrase?: string }> {
	const data = (await readPrivateInput()) as { passphrase?: unknown };
	if (
		!data ||
		typeof data !== "object" ||
		(data.passphrase !== undefined &&
			(typeof data.passphrase !== "string" ||
				data.passphrase.length < 10 ||
				data.passphrase.length > 4096))
	)
		throw Error("Invalid provider export passphrase");
	return { passphrase: data.passphrase as string | undefined };
}
async function build(): Promise<SnapshotBuildResult> {
	const source = process.env[DB_SNAPSHOT_SOURCE_ENV]?.trim();
	const output = process.env[DB_SNAPSHOT_OUTPUT_ENV]?.trim();
	if (!source || !output) return { ok: false, error: "missing snapshot paths" };
	if (process.env[DB_SNAPSHOT_KINDS_ENV] === "provider-clear") {
		try {
			return clearProviderSettingsData(source);
		} catch {
			return { ok: false, error: "Provider settings clear is incomplete; retry to continue" };
		}
	}
	if (process.env[DB_SNAPSHOT_KINDS_ENV] === "provider-import") {
		try {
			return await prepareProviderSettingsImport(
				source,
				output,
				(await readPrivateInput()) as ProviderSettingsImportStageInput,
			);
		} catch {
			return { ok: false, error: "Provider settings import could not be prepared" };
		}
	}

	const { all, copied, providers } = selectedTables();
	if (copied.length === 0) return { ok: false, error: "nothing selected" };

	let src: Database | undefined;
	let out: Database | undefined;
	try {
		src = new Database(source, { readonly: true });
		out = new Database(output);
		out.run("PRAGMA journal_mode = WAL");
		out.run("ATTACH DATABASE ? AS src", [source]);
		const transfer = providers ? await providerInput() : undefined;
		try {
			// 用 `CREATE TABLE … AS SELECT … WHERE 0` 建表：列名/列序与源库完全一致，
			// 也就不依赖 `sqlite_master` 的 DDL 文本与真实列是否同步。
			// 快照只需要列结构——导入靠主库自己的约束做 `INSERT OR IGNORE`。
			out.transaction(() => {
				for (const table of all) {
					out?.run(`CREATE TABLE main.${table} AS SELECT * FROM src.${table} WHERE 0`);
				}
			})();
			out.transaction(() => {
				for (const table of copied) {
					if (table === "plugin_provider_settings") {
						// Limited below; one extra row detects overflow instead of truncating silently.
						out?.run(
							`INSERT INTO main.${table} SELECT * FROM src.${table} ORDER BY id LIMIT ${PROVIDER_SETTINGS_TRANSFER_LIMITS.records + 1}`,
						);
					} else out?.run(`INSERT INTO main.${table} SELECT * FROM src.${table}`);
				}
			})();
		} finally {
			out.run("DETACH DATABASE src");
		}
		let providerSettingsCount = 0,
			providerSettingsSealed = false;
		if (transfer) {
			const rows = out
				.query(
					"SELECT plugin_id AS pluginId,contribution_id AS contributionId,target_kind AS targetKind,target_id AS targetId,id FROM plugin_provider_settings ORDER BY id LIMIT ?",
				)
				.all(PROVIDER_SETTINGS_TRANSFER_LIMITS.records + 1) as Array<
				PluginSettingAddress & { id: string }
			>;
			if (rows.length > PROVIDER_SETTINGS_TRANSFER_LIMITS.records)
				throw Error("Provider settings export record limit exceeded");
			const reader = createSqlitePluginSettingsStore(out),
				items: BundleItem[] = [];
			let bytes = 0;
			for (const identity of rows) {
				const { id, ...address } = identity;
				const row = await reader.getSetting(address);
				if (!row) throw Error("Provider settings snapshot changed");
				bytes += Buffer.byteLength(row.configText);
				if (bytes > PROVIDER_SETTINGS_TRANSFER_LIMITS.bytes)
					throw Error("Provider settings export byte limit exceeded");
				if (row.state !== "deleted") {
					const opened = openProviderSetting(row);
					if (Object.keys(opened.secrets).length) {
						if (!transfer.passphrase)
							throw Error("Provider settings secrets require an export passphrase");
						bytes += Buffer.byteLength(JSON.stringify(opened.secrets));
						if (bytes > PROVIDER_SETTINGS_TRANSFER_LIMITS.bytes)
							throw Error("Provider settings export byte limit exceeded");
						const metadata = JSON.stringify([address, row.revision, row.configText]);
						items.push({
							kind: "provider-settings",
							id,
							label: "",
							data: { metadata, secrets: opened.secrets },
						});
					}
				}
			}
			if (items.length) {
				const sealed = await sealBundle(
					{ exportedAt: Date.now(), items },
					transfer.passphrase as string,
				);
				if (Buffer.byteLength(sealed) > 8 * 1024 * 1024)
					throw Error("Provider settings sealed output limit exceeded");
				writeFileSync(join(dirname(output), PROVIDER_SETTINGS_SEALED_ENTRY), sealed, {
					mode: 0o600,
					flag: "wx",
				});
				providerSettingsSealed = true;
			}
			out.run("UPDATE plugin_provider_settings SET secrets_envelope = NULL,key_id = NULL");
			providerSettingsCount = rows.length;
		}
		// Rebuild after removing host ciphertext so neither free pages nor WAL retain it.
		out.run("VACUUM");
		return { ok: true, ...(transfer ? { providerSettingsCount, providerSettingsSealed } : {}) };
	} catch (error) {
		return { ok: false, error: String(error).slice(0, 500) };
	} finally {
		try {
			out?.close();
		} catch {
			// 关闭失败不影响结果判定
		}
		try {
			src?.close();
		} catch {
			// 同上
		}
	}
}

const result = await build();
process.stdout.write(JSON.stringify(result));
process.exit(result.ok ? 0 : 1);
