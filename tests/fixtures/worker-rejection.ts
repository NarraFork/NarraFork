/** Settle Worker I/O before entering Bun's synchronous rejection matcher. */
export async function workerFailure(work: Promise<unknown>): Promise<unknown> {
	try {
		await work;
	} catch (error) {
		return error;
	}
	throw new Error("Expected Worker-backed operation to reject");
}

export async function workerRejection(work: Promise<unknown>): Promise<() => never> {
	const error = await workerFailure(work);
	return () => {
		throw error;
	};
}
