import { bodySql } from "../lib/narrator-bodies";
import { isPrefixToolsManifest, PREFIX_TOOLS_FORMAT } from "./narrator-prefix-snapshot-values";

export const PREFIX_SNAPSHOT_GRACE_MS = 24 * 60 * 60 * 1000;
export interface PrefixSnapshotGcOptions {
	/** Test/maintenance clock; production callers should leave this unset. */
	now?: number;
	graceMs?: number;
	batchSize?: number;
	protectedHashes?: string[];
}
export interface PrefixSnapshotGcResult {
	phase: "assets" | "messages" | "blocks" | "manifests" | "sweep" | "done";
	visited: number;
	deleted: number;
}
export type SnapshotQuery = <T>(
	statement: string,
	parameters: Array<string | number>,
) => Promise<T[]>;

/** Dedicated worker-local scratch state. No persistent schema or application bootstrap. */
export class PrefixSnapshotCollector {
	private state?: {
		phase: PrefixSnapshotGcResult["phase"];
		cursor: string;
		second: string;
		cutoff: string;
	};
	constructor(private query: SnapshotQuery) {}
	private async mark(hashes: string[]): Promise<void> {
		for (let start = 0; start < hashes.length; start += 64) {
			const batch = hashes.slice(start, start + 64).filter((hash) => /^[a-f0-9]{64}$/.test(hash));
			if (!batch.length) continue;
			await this.query(
				`INSERT INTO prefix_snapshot_gc_marks (hash) VALUES ${batch.map(() => "(?)").join(",")} ON CONFLICT (hash) DO NOTHING`,
				batch,
			);
		}
	}
	private async markBody(text: string): Promise<void> {
		// Malformed persisted content aborts the pass, rather than guessing that it has no refs.
		const body: unknown = JSON.parse(text);
		const hashes: string[] = [];
		const scan = (value: unknown) => {
			if (!value || typeof value !== "object") return;
			const raw = value as Record<string, unknown>;
			if (raw.type === "tool_loaded" && typeof raw.definitionSnapshotRef === "string")
				hashes.push(raw.definitionSnapshotRef);
			if (raw.type === "context_update" && typeof raw.snapshotRef === "string")
				hashes.push(raw.snapshotRef);
			const epoch = raw.epoch as
				| { prefix?: { contract?: string; tools?: string; parts?: Array<{ hash?: string }> } }
				| undefined;
			if (epoch?.prefix) {
				for (const hash of [epoch.prefix.contract, epoch.prefix.tools])
					if (typeof hash === "string") hashes.push(hash);
				for (const part of epoch.prefix.parts ?? [])
					if (typeof part?.hash === "string") hashes.push(part.hash);
			}
		};
		if (Array.isArray(body)) for (const item of body) scan(item);
		else if (body && typeof body === "object" && Array.isArray((body as { raw?: unknown }).raw))
			for (const item of (body as { raw: unknown[] }).raw) scan(item);
		else scan(body);
		await this.mark(hashes);
	}
	async step(options: PrefixSnapshotGcOptions): Promise<PrefixSnapshotGcResult> {
		const batch = Math.max(1, Math.min(128, options.batchSize ?? 32));
		if (!this.state || this.state.phase === "done") {
			await this.query(
				"CREATE TEMP TABLE IF NOT EXISTS prefix_snapshot_gc_marks (hash TEXT PRIMARY KEY)",
				[],
			);
			await this.query("DELETE FROM prefix_snapshot_gc_marks", []);
			this.state = {
				phase: "assets",
				cursor: "",
				second: "",
				cutoff: new Date(
					(options.now ?? Date.now()) - (options.graceMs ?? PREFIX_SNAPSHOT_GRACE_MS),
				).toISOString(),
			};
		}
		const state = this.state;
		await this.mark(options.protectedHashes ?? []);
		const next = (phase: PrefixSnapshotGcResult["phase"]) => {
			state.phase = phase;
			state.cursor = "";
			state.second = "";
		};
		let visited = 0;
		let deleted = 0;
		const sliceDeadline = Date.now() + 25;
		try {
			if (state.phase === "assets") {
				const rows = await this.query<{ block_id: string; asset_id: string; role: string }>(
					"SELECT block_id, asset_id, role FROM narrator_block_assets WHERE (block_id, asset_id) > (?, ?) ORDER BY block_id, asset_id LIMIT ?",
					[state.cursor, state.second, batch],
				);
				await this.mark(
					rows.filter((row) => row.role === "epoch_snapshot").map((row) => row.asset_id),
				);
				visited = rows.length;
				if (rows.length) {
					state.cursor = rows[rows.length - 1].block_id;
					state.second = rows[rows.length - 1].asset_id;
				}
				if (rows.length < batch) next("messages");
			} else if (state.phase === "messages" || state.phase === "blocks") {
				const table = state.phase === "messages" ? "narrator_messages" : "narrator_blocks";
				// Preserve legacy projections as conservative roots through the body layer;
				// the separate blocks phase also protects current/rows-only bodies.
				const column = state.phase === "messages" ? bodySql(table, false) : "payload";
				// One body at a time: one historical item may itself be arbitrarily large.
				const rows = await this.query<{ id: string }>(
					`SELECT id FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`,
					[state.cursor, batch],
				);
				for (const row of rows) {
					const body = await this.query<{ body: string }>(
						`SELECT CAST(${column} AS TEXT) AS body FROM ${table} WHERE id = ?`,
						[row.id],
					);
					if (body[0]) await this.markBody(body[0].body);
					state.cursor = row.id;
					visited++;
					if (Date.now() >= sliceDeadline) break;
				}
				if (rows.length < batch && visited === rows.length)
					next(state.phase === "messages" ? "blocks" : "manifests");
			} else if (state.phase === "manifests") {
				const rows = await this.query<{ sha256: string; prefix: string }>(
					"SELECT sha256, substr(text, 1, 1) AS prefix FROM narrator_text_snapshots WHERE sha256 > ? ORDER BY sha256 LIMIT ?",
					[state.cursor, batch],
				);
				for (const row of rows) {
					// Key order and leading whitespace are not reachability assumptions.
					if (/^[{\s]$/.test(row.prefix)) {
						const content = await this.query<{ text: string }>(
							"SELECT text FROM narrator_text_snapshots WHERE sha256 = ?",
							[row.sha256],
						);
						if (content[0]) {
							let manifest: unknown;
							try {
								manifest = JSON.parse(content[0].text);
							} catch {
								/* Ordinary text may start with a brace. */
							}
							if (
								manifest &&
								typeof manifest === "object" &&
								(manifest as { format?: unknown }).format === PREFIX_TOOLS_FORMAT
							) {
								if (!isPrefixToolsManifest(manifest))
									throw new Error("Prefix snapshot manifest is malformed");
								// Conservatively keep children of orphan manifests until the next pass.
								await this.mark(manifest.definitions);
							}
						}
					}
					state.cursor = row.sha256;
					visited++;
					if (Date.now() >= sliceDeadline) break;
				}
				if (rows.length < batch && visited === rows.length) next("sweep");
			} else if (state.phase === "sweep") {
				const rows = await this.query<{ sha256: string; created_at: string }>(
					"SELECT sha256, created_at FROM narrator_text_snapshots WHERE sha256 > ? ORDER BY sha256 LIMIT ?",
					[state.cursor, batch],
				);
				for (const row of rows) {
					if (row.created_at < state.cutoff) {
						// Recheck publication leases and indexed refs at DELETE time, not just mark time.
						const removed = await this.query<{ sha256: string }>(
							"DELETE FROM narrator_text_snapshots WHERE sha256 = ? AND created_at < ? AND NOT EXISTS (SELECT 1 FROM prefix_snapshot_gc_marks WHERE hash = ?) AND NOT EXISTS (SELECT 1 FROM narrator_block_assets WHERE asset_id = ? AND role = 'epoch_snapshot') RETURNING sha256",
							[row.sha256, state.cutoff, row.sha256, row.sha256],
						);
						deleted += removed.length;
					}
					state.cursor = row.sha256;
					visited++;
					if (Date.now() >= sliceDeadline) break;
				}
				if (rows.length < batch && visited === rows.length) next("done");
			}
			return { phase: state.phase, visited, deleted };
		} catch (error) {
			// A failed source scan cannot be resumed at sweep with an incomplete mark set.
			this.state = undefined;
			throw error;
		}
	}
}
