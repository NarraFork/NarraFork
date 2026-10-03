import "@mantine/core/styles.css";
import { MantineProvider } from "@mantine/core";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import en from "../../../locales/en/narrator.json";
import zh from "../../../locales/zh-CN/narrator.json";
import {
	NarratorStatusBar,
	NarratorStatusToolbar,
	type NarratorStatusToolbarAction,
} from "../header/NarratorStatusToolbar";
import { createPlanReflectionStatusAction } from "./PlanReflectionStatusControl";
import type { BooleanOverride } from "./reflection-types";

export interface ReflectionFixtureOptions {
	width: number;
	language: "en" | "zh-CN";
	effective: boolean;
	globalDefault: boolean;
	disabled: boolean;
}
export interface ReflectionFixtureHarness {
	setOptions: (options: Partial<ReflectionFixtureOptions>) => void;
	changes: BooleanOverride[];
}
declare global {
	interface Window {
		__reflectionFixture?: ReflectionFixtureHarness;
	}
}

const changes: BooleanOverride[] = [];
function Fixture() {
	const [options, setOptions] = useState<ReflectionFixtureOptions>({
		width: 800,
		language: "en",
		effective: false,
		globalDefault: true,
		disabled: false,
	});
	useEffect(() => {
		window.__reflectionFixture = {
			changes,
			setOptions: (next) => setOptions((previous) => ({ ...previous, ...next })),
		};
		return () => {
			delete window.__reflectionFixture;
		};
	}, []);
	const strings = options.language === "en" ? en : zh;
	const t = (key: string) => strings[key as keyof typeof strings] as string;
	const reflection = createPlanReflectionStatusAction({
		hasPlanTrait: true,
		supported: true,
		isWorkspacePreview: false,
		effective: options.effective,
		globalDefault: options.globalDefault,
		disabled: options.disabled,
		t,
		onChange: (value) => {
			changes.push(value);
			setOptions((previous) => ({
				...previous,
				effective: value === "inherit" ? previous.globalDefault : value === "on",
			}));
		},
	});
	const actions: NarratorStatusToolbarAction[] = [
		...(reflection ? [reflection] : []),
		{
			key: "other",
			collapsePriority: 10,
			render: () => (
				<button type="button" style={{ width: 40, height: 22, whiteSpace: "nowrap", fontSize: 12 }}>
					Other
				</button>
			),
		},
	];
	return (
		<MantineProvider>
			<div
				id="panel"
				data-language={options.language}
				data-effective={options.effective ? "on" : "off"}
				data-disabled={options.disabled ? "true" : "false"}
				style={{ width: options.width }}
			>
				<NarratorStatusBar>
					<div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>Status</div>
					<div style={{ minWidth: 0, flexShrink: 1 }}>
						<NarratorStatusToolbar
							leading={
								<button
									type="button"
									style={{ width: 120, height: 22, whiteSpace: "nowrap", fontSize: 12 }}
								>
									Model / permission
								</button>
							}
							actions={actions}
							moreLabel="More actions"
							measurementKey={`${options.language}:${options.effective}`}
						/>
					</div>
				</NarratorStatusBar>
			</div>
		</MantineProvider>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing isolated reflection fixture root");
createRoot(root).render(<Fixture />);
