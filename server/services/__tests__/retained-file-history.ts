import { spyOn } from "bun:test";
import * as fileHistoryPolicy from "@shared/file-change-protocol";
import type { ExecutionBackend } from "../../lib/agent/execution/backend";
import { LocalFileChangeRuntime } from "../file-change-runtime";

/** Exercise retained history without adding a production local-policy override. */
export function retainFileHistoryForTests(runtime: LocalFileChangeRuntime): () => void {
	const internal = runtime as unknown as {
		executeBound(request: { backend: ExecutionBackend }): Promise<unknown>;
	};
	const original = internal.executeBound;
	internal.executeBound = (request) =>
		original.call(runtime, {
			...request,
			backend: new Proxy(request.backend, {
				get(target, property) {
					return property === "kind" ? "remote" : Reflect.get(target, property);
				},
			}),
		});
	return () => {
		internal.executeBound = original;
	};
}

export function makeRetainedHistoryRuntimeForTests(
	...args: ConstructorParameters<typeof LocalFileChangeRuntime>
): LocalFileChangeRuntime {
	const runtime = new LocalFileChangeRuntime(...args);
	retainFileHistoryForTests(runtime);
	return runtime;
}

export function allowRetainedFileHistoryForTests(): () => void {
	const policy = spyOn(fileHistoryPolicy, "isFileHistoryEnabledForDevice").mockReturnValue(true);
	return () => policy.mockRestore();
}
