import parserSource from "@babel/parser" with { type: "text" };
import { PLUGIN_UI_SHARED_MODULES } from "@frontend/plugin-runtime/contract";
import { hotSafe } from "@server/lib/hot-safe";
import { WorkerHandle } from "@server/lib/worker-runtime/lifecycle";
import {
	type PoolWorker,
	WorkerPool,
	type WorkerTaskContext,
} from "@server/lib/worker-runtime/pool";
import { TaskQueueError } from "@server/lib/worker-runtime/queue";
import { GEN_UI_FILE_LIMITS as LIMITS } from "@shared/gen-ui-files";
import { GEN_UI_KIT_GLOBAL, GEN_UI_KIT_MODULE } from "@shared/gen-ui-kit";
import { type SourceFile, uiError } from "./files";

// Inline source is embedded by Bun --compile. The worker has no filesystem module
// loader: every resolve/load hook either returns authorized memory or throws.
const COMPILER_SOURCE =
	`const parser = (() => { const exports = {}; ${parserSource as unknown as string}\nreturn exports; })();\n` +
	String.raw`
const images = {png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',svg:'image/svg+xml',avif:'image/avif',ico:'image/x-icon'};
self.onmessage = async ({data}) => {
 try {
  const files = new Map(data.files.map(f => [f.path, f.bytes]));
  // specifier -> {expression, exports}: globals the preview shell has already loaded.
  const shared = data.modules;
  const decoder = new TextDecoder('utf-8', {fatal:true});
  const validateScript = (source,ext,filename) => {
   const plugins=['deprecatedImportAssert'];
   if (ext === 'ts' || ext === 'tsx') plugins.push('typescript');
   if (ext === 'jsx' || ext === 'tsx') plugins.push('jsx');
   const ast = parser.parse(source,{sourceType:'module',plugins,createImportExpressions:true});
   const nodes=[ast];
   while(nodes.length) {
    const node=nodes.pop();
    if (!node || typeof node !== 'object') continue;
    if ((node.attributes?.length || node.assertions?.length) && ['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type)) throw new Error('Import attributes and build-time macros are not supported');
    if (['ImportDeclaration','ExportNamedDeclaration','ExportAllDeclaration'].includes(node.type) && node.source) resolve(node.source.value,filename,'import-statement');
    if (node.type === 'ImportExpression' && (node.source.type !== 'StringLiteral' || node.options)) throw new Error('Dynamic import specifiers and import attributes are not supported');
    if (node.type === 'ImportExpression') resolve(node.source.value,filename,'dynamic-import');
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && (node.arguments.length !== 1 || node.arguments[0].type !== 'StringLiteral')) throw new Error('Dynamic require is not supported');
    for (const [key,value] of Object.entries(node)) {
     if (['loc','start','end','comments','tokens'].includes(key)) continue;
     if (Array.isArray(value)) nodes.push(...value);
     else if (value && typeof value === 'object') nodes.push(value);
    }
   }
  };
  const normalize = (path) => {
   const parts = [];
   for (const part of path.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') { if (!parts.length) throw new Error('Import escapes UI directory'); parts.pop(); }
    else parts.push(part);
   }
   return parts.join('/');
  };
  const resolve = (path, importer, kind) => {
   if (path === '__nf_entry__' && !importer) return {path:'__nf_entry__',namespace:'ui'};
   if (Object.hasOwn(shared,path)) return {path:path+'.mjs',namespace:'runtime'};
   if (importer?.endsWith('.css') && !path.startsWith('.') && !/^(?:[a-zA-Z][\w+.-]*:|\/)/.test(path)) path='./'+path;
   if (!path.startsWith('./') && !path.startsWith('../')) throw new Error('Unsupported import: '+path+'; use a relative file or one of: '+Object.keys(shared).join(', '));
   if (path.includes('\\') || /[?#\x00]/.test(path)) throw new Error('Invalid UI import path: '+path);
   const base = importer === '__nf_entry__' ? '' : importer.slice(0,importer.lastIndexOf('/')+1);
   const candidate = normalize(base+path);
   const choices = [candidate,...['.tsx','.ts','.jsx','.js','.json','.css','/index.tsx','/index.ts','/index.jsx','/index.js'].map(ext=>candidate+ext)];
   const found = choices.find(p=>files.has(p));
   if (!found) throw new Error('UI import not found: '+path);
   if (kind === 'url-token' || (importer.endsWith('.css') && images[found.split('.').pop().toLowerCase()])) {
    const ext = found.split('.').pop().toLowerCase();
    if (!images[ext]) throw new Error('CSS URLs only support local static images');
    return {path:'data:'+images[ext]+';base64,'+Buffer.from(files.get(found)).toString('base64'),external:true};
   }
   // Keep JS image adapters distinct from CSS URL identities in Bun's resolve cache.
   if (images[found.split('.').pop().toLowerCase()]) return {path:found+'.mjs',namespace:'ui-image'};
   return {path:found,namespace:found.endsWith('.css') ? 'ui-css' : 'ui'};
  };
  const result = await Bun.build({
   entrypoints:['__nf_entry__'], target:'browser', format:'iife', splitting:false, throw:false,
   minify:false, sourcemap:'none', env:'disable', allowUnresolved:[],
   jsx:{runtime:'automatic',importSource:'react',development:false},
   define:{'process.env.NODE_ENV':'"production"'},
   plugins:[{name:'authorized-memory-only',setup(build){
    build.onResolve({filter:/.*/}, args=>resolve(args.path,args.importer,args.kind));
    build.onLoad({filter:/.*/,namespace:'runtime'}, ({path})=>({
     loader:'js', contents:'const shared = '+shared[path.slice(0,-4)].expression+';\n'+shared[path.slice(0,-4)].exports.map((name,index)=>'const e'+index+' = shared['+JSON.stringify(name)+']; export {e'+index+' as '+name+'};').join('\n')
    }));
    build.onLoad({filter:/.*/,namespace:'ui-image'}, ({path})=>{ const file=path.slice(0,-4); const ext=file.split('.').pop().toLowerCase(); return {loader:'js',contents:'export default '+JSON.stringify('data:'+images[ext]+';base64,'+Buffer.from(files.get(file)).toString('base64'))+';'}; });
    build.onLoad({filter:/.*/,namespace:'ui-css'}, ({path})=>({loader:'css',contents:decoder.decode(files.get(path))}));
    build.onLoad({filter:/.*/,namespace:'ui'}, ({path})=>{
     if (path === '__nf_entry__') return {loader:'js',contents:'import App from "./App.tsx"; globalThis.__nfGenUiApp = App;'};
     const bytes=files.get(path);
     if (!bytes) throw new Error('Unauthorized file: '+path);
     const ext=path.split('.').pop().toLowerCase();
     const source=decoder.decode(bytes);
     if (ext === 'css') return {loader:'css',contents:source};
     if (ext === 'json') return {loader:'json',contents:source};
     if (!['tsx','ts','jsx','js'].includes(ext)) throw new Error('Unsupported source: '+path);
     validateScript(source,ext,path);
     return {loader:ext,contents:source};
    });
   }}]
  });
  if (!result.success) throw new Error(result.logs.map(String).join('\n').slice(0,4000)||'UI compilation failed');
  let bytes=0,js='',css='';
  for (const output of result.outputs) {
   bytes+=output.size;
   if (bytes>data.maxOutputBytes) throw new Error('UI exceeds the 4 MiB output limit');
   if (output.type.includes('javascript')) js+=await output.text();
   else if (output.type.includes('css')) css+=await output.text();
   else throw new Error('Unexpected UI build output');
  }
  if (!js) throw new Error('UI compilation produced no JavaScript');
  self.postMessage({js,css});
 } catch(error) { self.postMessage({error:String(error?.message||error).slice(0,4000)}); }
};
`;

let exportsPromise: Promise<Record<string, string[]>> | undefined;
function builtinExports(): Promise<Record<string, string[]>> {
	exportsPromise ??= Promise.all([
		import("react"),
		import("react-dom/client"),
		import("react/jsx-runtime"),
		import("@mantine/core"),
		import("@mantine/hooks"),
	]).then((modules) =>
		Object.fromEntries(
			modules.map((module, index) => [
				["React", "ReactDOMClient", "JsxRuntime", "MantineCore", "MantineHooks"][index],
				Object.keys(module).filter(
					(name) =>
						/^[A-Za-z_$][\w$]*$/.test(name) &&
						!(index === 0 && ["act", "captureOwnerStack"].includes(name)),
				),
			]),
		),
	);
	return exportsPromise;
}
/** Capitalised exports of the built-in Mantine runtime: the tags inline UI may use without a kit. */
export async function builtinComponentNames(): Promise<string[]> {
	return ((await builtinExports()).MantineCore ?? []).filter((name) => /^[A-Z]/.test(name));
}

/** A module the bundle does not contain: it reads a global the preview shell loaded first. */
interface SharedModule {
	expression: string;
	exports: string[];
}

/**
 * Which bare imports a preview may use. Without a project kit that is React plus
 * NarraFork's Mantine; with one it is the kit's own React (a second copy would break
 * hooks) plus the `kit` module exporting the project's components.
 */
async function sharedModules(kit?: {
	components: string[];
}): Promise<Record<string, SharedModule>> {
	const exports = await builtinExports();
	if (!kit) {
		return Object.fromEntries(
			Object.entries(PLUGIN_UI_SHARED_MODULES).map(([specifier, name]) => [
				specifier,
				{
					expression: `globalThis.__nfPluginRuntime[${JSON.stringify(name)}]`,
					exports: exports[name] ?? [],
				},
			]),
		);
	}
	const global = `globalThis.${GEN_UI_KIT_GLOBAL}`;
	return {
		react: { expression: `${global}.React`, exports: exports.React ?? [] },
		"react/jsx-runtime": { expression: `${global}.JsxRuntime`, exports: exports.JsxRuntime ?? [] },
		"react-dom/client": {
			expression: `${global}.ReactDOMClient`,
			exports: exports.ReactDOMClient ?? [],
		},
		[GEN_UI_KIT_MODULE]: {
			expression: `${global}.components`,
			// Names come from a workspace file; only identifiers may become export bindings.
			exports: kit.components.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name)),
		},
	};
}

interface CompileRequest {
	files: SourceFile[];
	kit?: { components: string[] };
}
interface CompileResult {
	js: string;
	css: string;
}

async function compilerWorker(
	context: WorkerTaskContext,
): Promise<PoolWorker<CompileRequest, CompileResult>> {
	// Keep the original phase boundary: loading trusted runtime exports is not compilation.
	await builtinExports();
	context.signal.throwIfAborted();
	const url = URL.createObjectURL(new Blob([COMPILER_SOURCE], { type: "application/javascript" }));
	let handle: WorkerHandle<Worker>;
	try {
		handle = WorkerHandle.bunThread(url);
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
	const worker = handle.resource;
	return {
		get closed() {
			return handle.closed;
		},
		async close() {
			await handle.close();
			URL.revokeObjectURL(url);
		},
		async run({ files, kit }, { signal }) {
			const modules = await sharedModules(kit);
			signal.throwIfAborted();
			return new Promise<CompileResult>((resolve, reject) => {
				const finish = (result?: CompileResult, error?: unknown) => {
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					worker.onmessage = null;
					worker.onerror = null;
					worker.removeEventListener("close", exited);
					if (result) resolve(result);
					else reject(error);
				};
				const abort = () => finish(undefined, signal.reason);
				const exited = () => finish(undefined, uiError("UI compiler worker exited"));
				const timer = setTimeout(() => {
					void handle.close().catch(() => {});
					finish(undefined, uiError("UI compilation exceeded 15 seconds", 408));
				}, LIMITS.timeoutMs);
				worker.onmessage = ({ data }: MessageEvent<CompileResult & { error?: string }>) => {
					if (data?.error) finish(undefined, uiError(data.error));
					else if (
						typeof data?.js !== "string" ||
						typeof data?.css !== "string" ||
						Buffer.byteLength(data.js) + Buffer.byteLength(data.css) > LIMITS.outputBytes
					)
						finish(undefined, uiError("Invalid or oversized UI compilation output", 413));
					else finish({ js: data.js, css: data.css });
				};
				worker.onerror = (event) => finish(undefined, uiError(event.message.slice(0, 600)));
				worker.addEventListener("close", exited, { once: true });
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				else
					try {
						worker.postMessage({ files, modules, maxOutputBytes: LIMITS.outputBytes });
					} catch (error) {
						finish(undefined, error);
					}
			});
		},
	};
}

// No waiting queue and no worker reuse: the previous concurrency-2 rejection remains intact.
const compilerOwner = hotSafe(
	"narrafork.genUi.compilerWorkers.v1",
	() =>
		new WorkerPool<CompileRequest, CompileResult>({
			concurrency: 2,
			maxQueued: 0,
			reuse: false,
			create: compilerWorker,
		}),
);

/** Permanent HMR-shared admission latch; waits for pending creation and actual native exits. */
export function closeGenUiCompilerWorkers(): Promise<void> {
	return compilerOwner.close(uiError("UI compiler workers are closed", 503));
}

export async function compilePreview(
	files: SourceFile[],
	signal: AbortSignal,
	kit?: { components: string[] },
): Promise<CompileResult> {
	signal.throwIfAborted();
	if (files.length > LIMITS.files || files.some((file) => file.bytes.byteLength > LIMITS.fileBytes))
		throw uiError("UI compiler input exceeds its file/source limits", 413);
	const bytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
	if (bytes > LIMITS.sourceBytes)
		throw uiError("UI compiler input exceeds its file/source limits", 413);
	const started = Date.now();
	try {
		return await compilerOwner.run({ files, kit }, { signal, bytes, deadlineAt: Infinity });
	} catch (error) {
		if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
			throw uiError("UI compiler is busy; retry shortly", 429);
		throw error;
	} finally {
		// A diagnostic sink must not skip cleanup or change a successful compilation.
		if (Date.now() - started >= 1000)
			try {
				const { logger } = await import("@server/lib/logger");
				logger.warn("Slow GenUI compilation", {
					elapsedMs: Date.now() - started,
					files: files.length,
				});
			} catch {
				/* Observability is not execution authority. */
			}
	}
}
