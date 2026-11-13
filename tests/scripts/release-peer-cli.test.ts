import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
function fixture(flags: string[], uploadOnly = true) {
	mkdirSync(join(root, ".narrafork"), { recursive: true });
	const dir = mkdtempSync(join(root, ".narrafork/release-peer-cli-"));
	const entry = join(dir, "entry.ts");
	const paths = (path: string) => JSON.stringify(resolve(root, path));
	writeFileSync(
		entry,
		`
import {mock} from 'bun:test';
import * as fs from 'node:fs';
import * as child from 'node:child_process';
import * as gh from ${paths("scripts/lib/github-release.ts")};
const actions=[];const read=fs.readFileSync;const exists=fs.existsSync;
mock.module('node:fs',()=>({...fs,existsSync:p=>String(p)===${JSON.stringify(join(root, "changelogs/v1.2.0.json"))}?true:exists(p),readFileSync:(p,...a)=>String(p)===${JSON.stringify(join(root, "package.json"))}?JSON.stringify({version:${JSON.stringify(uploadOnly ? "1.2.0" : "1.1.0")}}):String(p)===${JSON.stringify(join(root, "changelogs/v1.2.0.json"))}?JSON.stringify({en:'test','zh-CN':'测试'}):read(p,...a),writeFileSync:()=>{throw Error('Unexpected source mutation')}}));
mock.module('node:child_process',()=>({...child,execFileSync:(cmd,args)=>{actions.push({cmd,args});if(cmd==='git'&&args.includes('--git-common-dir'))return '/primary/.git\\n/primary/.git\\n';throw Error('Unexpected build or Git write')}}));
mock.module(${paths("scripts/lib/build-repository.ts")},()=>({resolveBuildGitHubRepository:()=> 'fixture/nf'}));
mock.module(${paths("scripts/lib/release-git.ts")},()=>({getUnexpectedReleaseChanges:()=>[],resolveGitCommit:()=> '${"a".repeat(40)}'}));
mock.module(${paths("scripts/lib/main-release-dispatch.ts")},()=>({releaseSourceDeclaresRemotePeer:()=>true,dispatchMainRelease:async opts=>{actions.push({dispatch:opts.repository,version:opts.version,commit:opts.commit});return {runId:123,commit:opts.commit}}}));
mock.module(${paths("scripts/lib/local-github-patch-source.ts")},()=>({validatePublishedPatchSources:async()=>{}}));
mock.module(${paths("scripts/lib/update-index.ts")},()=>({prepareUpdateIndexRelease:async()=>({})}));
mock.module(${paths("scripts/lib/update-index-github.ts")},()=>({preparePublishedUpdateIndexRelease:async()=>({}),publishUpdateIndex:async()=>{throw Error('Unexpected metadata write')}}));
mock.module(${paths("scripts/lib/github-release.ts")},()=>({...gh,publishGitHubRelease:async opts=>{if(!opts.dryRun)throw Error('Direct local publisher bypassed peer CI');actions.push({localPreview:true});return {dryRun:true,assets:[]}}}));
process.on('exit',code=>console.log(JSON.stringify({code,actions})));
process.argv=[process.execPath,${paths("scripts/release.ts")},'1.2.0','--target=github',...${JSON.stringify(uploadOnly ? ["--upload-only"] : [])},...${JSON.stringify(flags)}];
try{await import(${paths("scripts/release.ts")})}catch(e){console.error(e.message);process.exitCode=1;}
`,
	);
	try {
		const result = Bun.spawnSync([process.execPath, entry], {
			cwd: root,
			timeout: 10_000,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, HOME: dir, USERPROFILE: dir },
		});
		const out = result.stdout.toString();
		return {
			status: result.exitCode,
			output: out + result.stderr.toString(),
			...JSON.parse(out.trim().split("\n").at(-1) ?? "{}"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
describe("real normal CLI publication includes peer automatically", () => {
	test("routes a declared peer release to main CI without a separate peer publisher or local build", () => {
		const result = fixture([]);
		expect(result.status).toBe(0);
		expect(result.actions.filter((x: { dispatch?: string }) => x.dispatch)).toEqual([
			{ dispatch: "fixture/nf", version: "1.2.0", commit: "a".repeat(40) },
		]);
		expect(result.output).toContain("no separate component publish command");
	});
	test("dry run remains local and does not dispatch or publish", () => {
		const result = fixture(["--dry-run"]);
		expect(result.status).toBe(0);
		expect(result.actions).toContainEqual({ localPreview: true });
		expect(result.actions.some((x: { dispatch?: string }) => x.dispatch)).toBe(false);
	});
	test("index-only does not dispatch or supplement peer", () => {
		const result = fixture(["--index-only"]);
		expect(result.status).toBe(0);
		expect(result.actions.some((x: { dispatch?: string }) => x.dispatch)).toBe(false);
	});
	for (const flag of ["--platform=linux-x64", "--skip-build"])
		test(`rejects ${flag} before a normal version bump or Git commit`, () => {
			const result = fixture([flag], false);
			expect(result.status).toBe(1);
			expect(result.output).toContain("Release option preflight failed");
			expect(result.output).toContain("complete native CI matrix");
			expect(result.output).not.toContain("Unexpected source mutation");
			expect(
				result.actions.some(
					(action: { cmd?: string; args?: string[]; dispatch?: string }) =>
						action.dispatch || action.args?.some((arg) => ["add", "commit", "tag"].includes(arg)),
				),
			).toBe(false);
		});
	test("does not silently reinterpret a single-platform request as complete publication", () => {
		const result = fixture(["--platform=linux-x64"]);
		expect(result.status).toBe(1);
		expect(result.actions.some((x: { dispatch?: string }) => x.dispatch)).toBe(false);
		expect(result.output).toContain("complete native CI matrix");
	});
});
