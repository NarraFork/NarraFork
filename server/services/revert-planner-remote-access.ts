import type { FileChangeExecutionBinding } from "@shared/file-change-protocol";
import type { RevertUnknownCoverage } from "@shared/partial-revert";
import { remoteHistoryFileState } from "@shared/remote-history-protocol";
import type { RemoteFileChangeRuntime } from "./remote-file-change-runtime";
import { assertRemoteHistoryBinding } from "./remote-history-service";
import type {
	RevertPlannerAccess,
	RevertPlannerFileAccess,
	RevertPlannerFileTarget,
} from "./revert-planner-service";

/** Must be backed by narrator/project/device ACL + granted path + current lease.
 * No default-allow callback or current-directory fallback exists in this adapter. */
export interface RemoteRevertAuthority
	extends Pick<
		RevertPlannerAccess,
		"authenticate" | "authorizeNarrator" | "resolveContext" | "authorizeFile"
	> {
	resolveRecordedScope(input: RevertPlannerFileAccess): Promise<{
		runtime: RemoteFileChangeRuntime;
		executionBinding: FileChangeExecutionBinding;
		scopeRevision: number;
		unknownCoverage?: RevertUnknownCoverage[];
		assertCurrent(signal: AbortSignal): Promise<void>;
	}>;
}

/** Reuses the provider-independent planner; no host FS calls or inverse logic. */
export class RevertPlannerRemoteAccess implements RevertPlannerAccess {
	constructor(private readonly authority: RemoteRevertAuthority) {}

	authenticate: RevertPlannerAccess["authenticate"] = (principal, signal) =>
		this.authority.authenticate(principal, signal);

	authorizeNarrator: RevertPlannerAccess["authorizeNarrator"] = (...args) =>
		this.authority.authorizeNarrator(...args);

	resolveContext: RevertPlannerAccess["resolveContext"] = (input) =>
		this.authority.resolveContext(input);

	authorizeFile: RevertPlannerAccess["authorizeFile"] = (input) =>
		this.authority.authorizeFile(input);

	async resolveFile(input: RevertPlannerFileAccess): Promise<RevertPlannerFileTarget> {
		await this.authority.authorizeFile(input);
		const granted = await this.authority.resolveRecordedScope(input);
		const identity = Object.freeze({ ...input.identity });
		const binding = Object.freeze({ ...granted.runtime.history.binding });
		granted.runtime.relativePath(identity);
		const assertCurrent = async ({ signal }: { signal: AbortSignal }) => {
			signal.throwIfAborted();
			await this.authority.authorizeFile({ ...input, identity, signal });
			await granted.assertCurrent(signal);
			assertRemoteHistoryBinding(binding, granted.runtime.history.binding);
		};
		await assertCurrent({ signal: input.signal });
		return {
			identity,
			executionBinding: Object.freeze({ ...granted.executionBinding }),
			scopeRevision: granted.scopeRevision,
			unknownCoverage: granted.unknownCoverage,
			assertCurrent,
			readCurrent: async ({ signal, maxBytes }) => {
				await assertCurrent({ signal });
				const observation = await granted.runtime.observe(identity, signal);
				if (observation.bytes && observation.bytes.byteLength > maxBytes)
					throw new Error("Remote current-state evidence exceeds planner budget");
				await assertCurrent({ signal });
				return { state: remoteHistoryFileState(observation.state), raw: observation.bytes };
			},
		};
	}
}
