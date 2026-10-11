import type {
	IntelligentUiFileReference,
	IntelligentUiPreview,
} from "@shared/intelligent-ui-files";

export const fileReference: IntelligentUiFileReference = {
	version: 1,
	toolUseId: "tool/1",
	toolCallId: "call/1",
	deviceId: "local",
	workspaceKey: "workspace",
	cwd: "/workspace",
	directory: ".narrafork/intelligent_ui/demo-123",
	entry: "App.tsx",
	title: "Demo preview",
};

export function previewResult(label = "Current file"): IntelligentUiPreview {
	return {
		directory: fileReference.directory,
		entry: fileReference.entry,
		files: ["App.tsx"],
		css: "#app { max-width: 600px; }",
		js: `(() => {
      const { React, MantineCore } = globalThis.__nfPluginRuntime;
      globalThis.__nfIntelligentUiApp = function App() {
        const [count, setCount] = React.useState(0);
        return React.createElement("form", { id: "app", onSubmit: e => e.preventDefault() },
          React.createElement("p", { id: "version" }, ${JSON.stringify(label)}),
          React.createElement(MantineCore.TextInput, { label: "Name", id: "name", placeholder: "Your name" }),
          React.createElement(MantineCore.Button, { id: "increment", onClick: () => setCount(count + 1) }, "Count " + count));
      };
    })();`,
	};
}

/**
 * Environment for a browser launched from a test. The test preload points HOME and
 * USERPROFILE at a throwaway directory, and on Windows a browser will not start against a
 * profile root that is not the OS user's. HOMEDRIVE/HOMEPATH are the one description of
 * the real home the preload leaves alone, for every file in a run and not just the first.
 */
export function browserLaunchEnvironment(): Record<string, string | undefined> {
	const { HOMEDRIVE, HOMEPATH } = process.env;
	if (process.platform !== "win32" || !HOMEDRIVE || !HOMEPATH) return { ...process.env };
	const home = `${HOMEDRIVE}${HOMEPATH}`;
	return { ...process.env, HOME: home, USERPROFILE: home };
}
