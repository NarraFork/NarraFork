import { expect, mock, test } from "bun:test";
import { spawnWindowsReplacementProcess } from "../windows-replacement-process";

type Api = NonNullable<Parameters<typeof spawnWindowsReplacementProcess>[1]>;
const wide = (buffer: Buffer) => buffer.toString("utf16le").replace(/\0$/, "");
const options = {
	execPath: "C:\\程序 空格 & %PATH%\\narrafork.exe",
	args: ["--manager"],
	cwd: "C:\\工作 空格 & %PATH%",
	env: { Path: "C:\\Windows", NARRAFORK_GRACEFUL_RESTART_TOKEN: "secret" },
};
function fixture() {
	const create = mock<Api["CreateProcessW"]>((...args) => {
		args[9].writeBigUInt64LE(101n, 0);
		args[9].writeBigUInt64LE(102n, 8);
		args[9].writeUInt32LE(4321, 16);
		return 1;
	});
	const close = mock<Api["CloseHandle"]>(() => 1);
	const error = mock(() => 5);
	const api = { CreateProcessW: create, CloseHandle: close, GetLastError: error };
	return { create, close, error, api };
}

test("creates a hidden, breakaway Unicode process with no handle inheritance, then closes handles", () => {
	const { api, create, close } = fixture();
	expect(spawnWindowsReplacementProcess(options, api)).toBe(4321);
	expect(create).toHaveBeenCalledTimes(1);
	const call = create.mock.calls[0];
	if (!call) throw new Error("No CreateProcessW call");
	expect(wide(call[0])).toBe(options.execPath);
	expect(wide(call[1])).toBe(`"${options.execPath}" "--manager"`);
	expect(call.slice(2, 6)).toEqual([null, null, 0, 0x01000608]);
	expect(wide(call[7])).toBe(options.cwd);
	expect(call[8].byteLength).toBe(104);
	expect(call[8].readUInt32LE(0)).toBe(104);
	expect(call[8].readUInt32LE(60)).toBe(1);
	expect(call[8].readUInt16LE(64)).toBe(0);
	expect(call[8].subarray(80)).toEqual(Buffer.alloc(24));
	expect(call[9].byteLength).toBe(24);
	expect(close.mock.calls.map(([handle]) => Number(handle))).toEqual([102, 101]);
});

test("quotes empty arguments, quotes and trailing backslashes without shell expansion", () => {
	const { api, create } = fixture();
	const args = ["", "plain", "space separated", "tail\\", 'a\\"b', 'a"b', "%PATH% &"];
	spawnWindowsReplacementProcess({ ...options, args }, api);
	expect(wide(create.mock.calls[0]?.[1] ?? Buffer.alloc(0))).toBe(
		[
			`"${options.execPath}"`,
			'""',
			'"plain"',
			'"space separated"',
			String.raw`"tail\\"`,
			String.raw`"a\\\"b"`,
			String.raw`"a\"b"`,
			'"%PATH% &"',
		].join(" "),
	);
});

test("preserves Unicode handoff/proxy values in a sorted, case-insensitive, double-NUL environment", () => {
	const { api, create } = fixture();
	spawnWindowsReplacementProcess(
		{
			...options,
			env: {
				z: "last",
				Path: "old",
				PATH: "new",
				"=C:": "C:\\work",
				omit: undefined,
				NARRAFORK_GRACEFUL_RESTART_TOKEN: "秘密 & %PATH%",
				HTTPS_PROXY: "http://user:password@proxy.invalid:8080",
			},
		},
		api,
	);
	const environment = create.mock.calls[0]?.[6];
	expect(environment?.toString("utf16le")).toBe(
		[
			"=C:=C:\\work",
			"HTTPS_PROXY=http://user:password@proxy.invalid:8080",
			"NARRAFORK_GRACEFUL_RESTART_TOKEN=秘密 & %PATH%",
			"PATH=new",
			"z=last",
			"",
			"",
		].join("\0"),
	);
});

test("empty environment still has two Unicode NULs", () => {
	const { api, create } = fixture();
	spawnWindowsReplacementProcess({ ...options, env: {} }, api);
	expect(create.mock.calls[0]?.[6]).toEqual(Buffer.alloc(4));
});

test("reports native breakaway failure without exposing credentials or closing invalid handles", () => {
	const { api, create, close, error } = fixture();
	create.mockReturnValue(0);
	expect(() => spawnWindowsReplacementProcess(options, api)).toThrow(
		"Windows replacement CreateProcessW failed (win32=5)",
	);
	expect(create).toHaveBeenCalledTimes(1);
	expect(error).toHaveBeenCalledTimes(1);
	expect(close).not.toHaveBeenCalled();
});

for (const invalid of [
	{ execPath: "bad\0.exe" },
	{ args: ["bad\0arg"] },
	{ cwd: "bad\0cwd" },
	{ args: ["x".repeat(32_767)] },
	{ env: { "": "value" } },
	{ env: { "bad=name": "value" } },
	{ env: { "bad\0name": "value" } },
	{ env: { key: "bad\0value" } },
	{ env: { key: "x".repeat(512 * 1024) } },
]) {
	test("rejects invalid or over-budget input before calling the DLL", () => {
		const { api, create } = fixture();
		expect(() => spawnWindowsReplacementProcess({ ...options, ...invalid }, api)).toThrow();
		expect(create).not.toHaveBeenCalled();
	});
}
