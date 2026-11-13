import { relative, resolve } from "node:path";
import type { Plugin } from "vite";

/** Substitution is by resolved source identity, covering relative and alias imports. */
export const REMOTE_MODULE_REPLACEMENTS: Readonly<Record<string, string>> = {
	"lib/business-transport.ts": "remote/business-transport.ts",
	"lib/base-path.ts": "remote/base-path.ts",
	"components/plugins/PluginContributionPicker.tsx": "remote/plugin-boundary.tsx",
	"components/plugins/PluginUiSurfaceContext.tsx": "remote/plugin-boundary.tsx",
	"components/gen-ui/GenUICard.tsx": "remote/plugin-boundary.tsx",
	"hooks/usePluginContributions.ts": "remote/unsupported-hooks.ts",
	"hooks/usePromptOptimize.ts": "remote/unsupported-hooks.ts",
	"components/narrator/dock/NarratorDockContext.tsx": "components/narrator/remote-ui-contexts.tsx",
	"components/narrator/workspace/workspace-dock.tsx": "components/narrator/remote-ui-contexts.tsx",
	"components/narrator/MobileToolPanelHost.tsx": "components/narrator/remote-ui-panels.tsx",
	"components/narrator/OutlineDrawerHost.tsx": "components/narrator/remote-ui-panels.tsx",
	"components/narrator/spec/SpecPanel.tsx": "components/narrator/remote-ui-panels.tsx",
	"components/narrator/file-panel/FilePanelContent.tsx": "components/narrator/remote-ui-panels.tsx",
	"components/narrator/details/NarratorDetailsPanel.tsx":
		"components/narrator/remote-ui-panels.tsx",
	"components/narrator/model/NugRechargeDialog.tsx": "components/narrator/remote-ui-panels.tsx",
	"components/narrator/header/NarratorWorktreeControls.tsx":
		"components/narrator/remote-ui-panels.tsx",
	"components/project/NarratorProjectSettings.tsx": "remote/plugin-boundary.tsx",
	"components/outline/plan/OutlinePlanDiffModal.tsx": "remote/plugin-boundary.tsx",
	"components/narrator/file-editor/MonacoEditor.tsx": "remote/plugin-boundary.tsx",
	"components/narrator/file-editor/monaco-loader.ts": "remote/plugin-boundary.tsx",
	"components/narrator/tool-call/ToolEditFileViewer.tsx":
		"components/narrator/remote-ui-panels.tsx",
	"components/narrator/SaveDumpModal.tsx": "remote/plugin-boundary.tsx",
	"components/outline/OpenInOutline.tsx": "remote/plugin-boundary.tsx",
	"components/common/DirectoryPicker.tsx": "remote/plugin-boundary.tsx",
	"components/outline/digest/OutlineDigestInbox.tsx": "remote/plugin-boundary.tsx",
	"components/narrator/vlist/vlist-outline-ask-bridge.tsx":
		"components/narrator/vlist/remote-outline-ask-bridge.tsx",
};

export function nativeModuleBoundary(): Plugin {
	return {
		name: "narrafork-native-module-boundary",
		generateBundle(_options, bundle) {
			for (const item of Object.values(bundle)) {
				if (item.type !== "chunk") continue;
				for (const id of Object.keys(item.modules)) {
					if (
						/\/(?:remote\/bootstrap|remote\/recovering-transport|remote-access\/browser-(?:client|transport))\.[tj]sx?$/.test(
							id.replace(/\\/g, "/"),
						)
					)
						this.error(`Native frontend imported RTC implementation: ${id}`);
				}
			}
		},
	};
}

export function remoteModuleBoundaries(frontendRoot: string, emitGraph = true): Plugin {
	const replacements = new Map(
		Object.entries(REMOTE_MODULE_REPLACEMENTS).map(([from, to]) => [
			resolve(frontendRoot, from).replace(/\\/g, "/"),
			resolve(frontendRoot, to),
		]),
	);
	return {
		name: "narrafork-remote-module-boundaries",
		enforce: "pre",
		async resolveId(source, importer, options) {
			if (!importer || source.startsWith("\0")) return null;
			const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
			if (!resolved) return null;
			const replacement = replacements.get(resolved.id.split("?")[0].replace(/\\/g, "/"));
			return replacement ?? null;
		},
		generateBundle(_options, bundle) {
			const modules = Object.values(bundle).flatMap((item) =>
				item.type === "chunk"
					? Object.entries(item.modules)
							.filter(([, detail]) => detail.renderedLength > 0)
							.map(([id]) => id)
					: [],
			);
			const prohibited = [
				"/frontend/main.tsx",
				"/frontend/App.tsx",
				"/frontend/routeTree.gen.ts",
				"/frontend/AuthenticatedAppLayout.tsx",
				"/frontend/components/AuthenticatedAppLayout.tsx",
				"/frontend/lib/business-transport.ts",
				"/frontend/src-sw.ts",
				"/frontend/lib/pwa.ts",
				"/frontend/components/plugins/PluginUiRuntimeProvider.tsx",
				"/frontend/components/plugins/registry.ts",
				...Object.keys(REMOTE_MODULE_REPLACEMENTS).map((path) => `/frontend/${path}`),
			];
			const leaked = modules.filter(
				(id) =>
					prohibited.some((path) => id.replace(/\\/g, "/").endsWith(path)) ||
					id.replace(/\\/g, "/").includes("/node_modules/monaco-editor/"),
			);
			if (leaked.length) this.error(`Remote build imported native startup: ${leaked.join(", ")}`);
			if (!emitGraph) return;
			this.emitFile({
				type: "asset",
				fileName: "remote-module-graph.json",
				source: JSON.stringify(
					modules.map((id) => relative(resolve(frontendRoot, ".."), id).replace(/\\/g, "/")),
				),
			});
		},
	};
}
