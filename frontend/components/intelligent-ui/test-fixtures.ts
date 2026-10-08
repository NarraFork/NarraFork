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
