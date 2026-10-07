/** Share in-flight/completed cleanup, but let a rejected teardown finish its work on retry. */
export function createShutdownTask<Options, Result>(
	cleanup: (options: Options) => Promise<Result>,
): (options: Options) => Promise<Result> {
	let task: Promise<Result> | null = null;
	return (options) => {
		if (task) return task;
		const next = Promise.resolve().then(() => cleanup(options));
		task = next;
		void next.catch(() => {
			if (task === next) task = null;
		});
		return next;
	};
}
