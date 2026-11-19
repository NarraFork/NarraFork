import { afterEach, expect, spyOn, test } from "bun:test";
import { ParcelWorkerClient } from "../parcel-worker-client";

const originalEnv = process.env.NARRAFORK_ENABLE_NATIVE_WATCHER;
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const script = `
process.stdout.write(JSON.stringify({type:'ready',pid:process.pid,backend:'fixture'})+'\\n');
let buffer='';
for await(const chunk of Bun.stdin.stream()){
 buffer+=new TextDecoder().decode(chunk);
 let end;
 while((end=buffer.indexOf('\\n'))>=0){
  const value=JSON.parse(buffer.slice(0,end)); buffer=buffer.slice(end+1);
  if(value.type==='shutdown') process.exit(0);
  if(value.type==='watch'||value.type==='unwatch') process.stdout.write(JSON.stringify({type:value.type+'_ack',requestId:value.requestId,id:value.id})+'\\n');
 }
}
`;

afterEach(() => {
	if (originalEnv === undefined) delete process.env.NARRAFORK_ENABLE_NATIVE_WATCHER;
	else process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = originalEnv;
});

test("real process subscription ACK, resubscription and final shutdown barrier", async () => {
	process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
	const original = Bun.spawn;
	const children: ReturnType<typeof Bun.spawn>[] = [];
	const spawn = spyOn(Bun, "spawn").mockImplementation((_command, options?) => {
		const child = original([process.execPath, "-e", script], options as never) as ReturnType<
			typeof Bun.spawn
		>;
		children.push(child);
		return child;
	});
	const client = new ParcelWorkerClient(
		() => {},
		() => {},
	);
	try {
		const subscription = await client.watch("/watch-fixture", []);
		expect(children).toHaveLength(1);
		children[0]?.kill("SIGKILL");
		// Preserve the real 800ms restart delay and the production subscription ACK budgets.
		const until = Date.now() + 3000;
		while (children.length < 2 && Date.now() < until) await Bun.sleep(10);
		expect(children).toHaveLength(2);
		await subscription.unsubscribe();
		await client.shutdown();
		for (const child of children) {
			await child.exited;
			expect(() => process.kill(child.pid, 0)).toThrow();
		}
		await expect(client.watch("/cannot-reopen", [])).rejects.toThrow("shutting down");
		expect(children).toHaveLength(2);
	} finally {
		await client.shutdown();
		spawn.mockRestore();
		for (const child of children) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
});

test("real not-ready process is killed on the unchanged ready deadline, never inline", async () => {
	process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
	const original = Bun.spawn;
	let child: ReturnType<typeof Bun.spawn> | undefined;
	let readyTimeout: (() => void) | undefined;
	const originalTimeout = globalThis.setTimeout;
	const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		delay?: number,
	) => {
		if (delay === 3000) readyTimeout = callback;
		return originalTimeout(callback, delay);
	}) as typeof setTimeout);
	const spawn = spyOn(Bun, "spawn").mockImplementation((_command, options?) => {
		child = original(
			[process.execPath, "-e", "await Bun.sleep(60000)"],
			options as never,
		) as ReturnType<typeof Bun.spawn>;
		return child;
	});
	const client = new ParcelWorkerClient(
		() => {},
		() => {},
	);
	const watching = client.watch("/not-ready", []);
	void watching.catch(() => {});
	try {
		await turn();
		expect(readyTimeout).toBeFunction();
		readyTimeout?.();
		await expect(watching).rejects.toThrow("ready timed out");
		await client.shutdown();
		expect(await child?.exited).not.toBe(0);
		expect(spawn).toHaveBeenCalledTimes(1);
	} finally {
		timer.mockRestore();
		spawn.mockRestore();
		await client.shutdown();
		if (child) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
});

test("disabled and failed creation do not execute watcher work locally", async () => {
	delete process.env.NARRAFORK_ENABLE_NATIVE_WATCHER;
	const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
		throw new Error("spawn denied");
	});
	const client = new ParcelWorkerClient(
		() => {},
		() => {},
	);
	try {
		await expect(client.watch("/disabled", [])).rejects.toThrow("disabled");
		expect(spawn).not.toHaveBeenCalled();
		process.env.NARRAFORK_ENABLE_NATIVE_WATCHER = "1";
		await expect(client.watch("/creation-failure", [])).rejects.toThrow("spawn denied");
		expect(spawn).toHaveBeenCalledTimes(1);
		await client.shutdown();
	} finally {
		spawn.mockRestore();
	}
});
