/**
 * MockStreamPanel.tsx — Operator UI for the scripted streaming harness.
 *
 * TEMPORARY MODULE (see ./README-REMOVAL.md).
 *
 * The content is FIXED (see mock-stream-corpus.ts), so there is nothing to pick:
 * the controls select how much of it to replay and how fast, not what it says.
 *
 * Copy is intentionally hard-coded English and NOT routed through i18n, matching
 * the precedent set by `vlist/VListHarness.tsx`: a debug surface that will be
 * deleted should not leave keys behind in the shipped locale bundles.
 */

import {
	Badge,
	Box,
	Button,
	Divider,
	Group,
	NumberInput,
	Progress,
	Stack,
	Switch,
	Text,
} from "@mantine/core";
import {
	IconPlayerPause,
	IconPlayerPlay,
	IconPlayerStop,
	IconPlayerTrackNext,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { DEFAULT_RUNNER_OPTIONS, MockStreamRunner } from "./mock-stream-runner";
import { DEFAULT_MOCK_SCENARIO, MOCK_ROUND_COUNT, type MockScenario } from "./mock-stream-script";
import { useMockStreamStats } from "./mock-stream-store";

export interface MockStreamPanelProps {
	narratorId: string;
}

export function MockStreamPanel({ narratorId }: MockStreamPanelProps) {
	// Which channels to emit, and how much of the fixed script.
	const [reasoning, setReasoning] = useState(DEFAULT_MOCK_SCENARIO.reasoning);
	const [text, setText] = useState(DEFAULT_MOCK_SCENARIO.text);
	const [tools, setTools] = useState(DEFAULT_MOCK_SCENARIO.tools);
	const [rounds, setRounds] = useState(DEFAULT_MOCK_SCENARIO.rounds);
	const [textRepeat, setTextRepeat] = useState(DEFAULT_MOCK_SCENARIO.textRepeat);

	// Pacing.
	const [charsPerFrame, setCharsPerFrame] = useState(DEFAULT_MOCK_SCENARIO.charsPerFrame);
	const [toolOutputCharsPerFrame, setToolOutputCharsPerFrame] = useState(
		DEFAULT_MOCK_SCENARIO.toolOutputCharsPerFrame,
	);
	const [intervalMs, setIntervalMs] = useState(DEFAULT_RUNNER_OPTIONS.intervalMs);
	const [framesPerTick, setFramesPerTick] = useState(DEFAULT_RUNNER_OPTIONS.framesPerTick);
	const [loop, setLoop] = useState(DEFAULT_RUNNER_OPTIONS.loop);

	// The runner mutates itself and notifies; a counter is enough to re-read its
	// snapshot (it is not React state and must not be copied into any).
	const [, forceRender] = useReducer((n: number) => n + 1, 0);
	const runnerRef = useRef<MockStreamRunner | null>(null);
	if (!runnerRef.current) runnerRef.current = new MockStreamRunner(() => forceRender());
	const runner = runnerRef.current;

	// A run must never outlive the panel: the flag it sets drives another panel's
	// `isActive`, and a leaked timer would keep dispatching into a dead surface.
	useEffect(() => {
		return () => runner.dispose();
	}, [runner]);

	const scenario = useMemo<MockScenario>(
		() => ({
			narratorId,
			reasoning,
			text,
			tools,
			rounds,
			charsPerFrame,
			toolOutputCharsPerFrame,
			textRepeat,
		}),
		[
			narratorId,
			reasoning,
			text,
			tools,
			rounds,
			charsPerFrame,
			toolOutputCharsPerFrame,
			textRepeat,
		],
	);

	const options = useMemo(
		() => ({ intervalMs, framesPerTick, loop }),
		[intervalMs, framesPerTick, loop],
	);

	// Pacing can change mid-run and takes effect on the next tick.
	useEffect(() => {
		runner.setOptions(options);
	}, [runner, options]);

	const snapshot = runner.snapshot;
	const stats = useMockStreamStats();
	const running = snapshot.phase === "running";

	const handlePlay = useCallback(() => {
		// Re-load whenever the script is empty or a previous run ended, so an edited
		// scenario is picked up without a separate "apply" button.
		if (snapshot.totalSteps === 0 || snapshot.phase === "finished" || snapshot.phase === "idle") {
			runner.load(scenario, options);
		}
		runner.start();
	}, [runner, scenario, options, snapshot.totalSteps, snapshot.phase]);

	const handleStep = useCallback(() => {
		if (snapshot.totalSteps === 0 || snapshot.phase === "finished") {
			runner.load(scenario, options);
		}
		runner.stepOnce();
	}, [runner, scenario, options, snapshot.totalSteps, snapshot.phase]);

	const progress =
		snapshot.totalSteps > 0 ? Math.round((snapshot.cursor / snapshot.totalSteps) * 100) : 0;

	return (
		<Box p="md">
			<Stack gap="sm">
				<Group gap="xs" justify="space-between" wrap="nowrap">
					<Text size="sm" fw={600}>
						Mock stream
					</Text>
					<Group gap={6} wrap="nowrap">
						{snapshot.round > 0 && (
							<Badge size="sm" variant="light" color="gray">
								round {snapshot.round}
							</Badge>
						)}
						<Badge
							size="sm"
							variant="light"
							color={
								snapshot.phase === "running"
									? "indigo"
									: snapshot.phase === "paused"
										? "yellow"
										: snapshot.phase === "finished"
											? "teal"
											: "gray"
							}
						>
							{snapshot.phase}
						</Badge>
					</Group>
				</Group>
				<Text size="xs" c="dimmed">
					Replays a fixed {MOCK_ROUND_COUNT}-round turn: reasoning → markdown (headings, inline +
					display math, code, mermaid, tables, lists) → tool calls (glob/read/grep, agent, edit,
					write, bash, failing bash, web search, plan, task board), then more reasoning. Nothing is
					persisted; reload clears it.
				</Text>

				<Group gap="xs" wrap="nowrap">
					<Button
						size="compact-sm"
						variant={running ? "light" : "filled"}
						leftSection={running ? <IconPlayerPause size={14} /> : <IconPlayerPlay size={14} />}
						onClick={running ? () => runner.pause() : handlePlay}
					>
						{running ? "Pause" : snapshot.phase === "paused" ? "Resume" : "Play"}
					</Button>
					<Button
						size="compact-sm"
						variant="default"
						leftSection={<IconPlayerTrackNext size={14} />}
						onClick={handleStep}
					>
						Step
					</Button>
					<Button
						size="compact-sm"
						variant="default"
						color="red"
						leftSection={<IconPlayerStop size={14} />}
						onClick={() => runner.stop()}
					>
						Stop
					</Button>
				</Group>

				<Box>
					<Progress value={progress} size="sm" color="indigo" />
					<Group gap="md" mt={4} wrap="wrap">
						<Text size="xs" c="dimmed">
							{snapshot.cursor} / {snapshot.totalSteps} frames
						</Text>
						<Text size="xs" c="dimmed">
							{stats.chars} / {stats.totalChars} chars
						</Text>
						<Text size="xs" c="dimmed">
							{(stats.elapsedMs / 1000).toFixed(1)}s
						</Text>
					</Group>
				</Box>

				<Divider label="Channels" labelPosition="left" />
				<Switch
					size="sm"
					label="Reasoning"
					checked={reasoning}
					onChange={(e) => setReasoning(e.currentTarget.checked)}
				/>
				<Switch
					size="sm"
					label="Markdown text"
					checked={text}
					onChange={(e) => setText(e.currentTarget.checked)}
				/>
				<Switch
					size="sm"
					label="Tool calls"
					checked={tools}
					onChange={(e) => setTools(e.currentTarget.checked)}
				/>

				<Divider label="Scope" labelPosition="left" />
				<NumberInput
					size="xs"
					label={`Rounds (1..${MOCK_ROUND_COUNT})`}
					description="Each round is reasoning → text → tools"
					min={1}
					max={MOCK_ROUND_COUNT}
					value={rounds}
					onChange={(v) => setRounds(Math.min(MOCK_ROUND_COUNT, Math.max(1, toInt(v, rounds))))}
				/>
				<NumberInput
					size="xs"
					label="Text repeat"
					description="Repeat each round's markdown body N times (volume stress)"
					min={1}
					max={50}
					value={textRepeat}
					onChange={(v) => setTextRepeat(Math.max(1, toInt(v, textRepeat)))}
				/>

				<Divider label="Pacing" labelPosition="left" />
				<NumberInput
					size="xs"
					label="Chars per delta frame"
					min={1}
					max={4000}
					value={charsPerFrame}
					onChange={(v) => setCharsPerFrame(Math.max(1, toInt(v, charsPerFrame)))}
				/>
				<NumberInput
					size="xs"
					label="Stdout chars per frame"
					min={1}
					max={50_000}
					step={50}
					value={toolOutputCharsPerFrame}
					onChange={(v) =>
						setToolOutputCharsPerFrame(Math.max(1, toInt(v, toolOutputCharsPerFrame)))
					}
				/>
				<NumberInput
					size="xs"
					label="Frame interval (ms)"
					min={0}
					max={2000}
					value={intervalMs}
					onChange={(v) => setIntervalMs(Math.max(0, toInt(v, intervalMs)))}
				/>
				<NumberInput
					size="xs"
					label="Frames per tick (burst)"
					min={1}
					max={200}
					value={framesPerTick}
					onChange={(v) => setFramesPerTick(Math.max(1, toInt(v, framesPerTick)))}
				/>
				<Switch
					size="sm"
					label="Loop"
					checked={loop}
					onChange={(e) => setLoop(e.currentTarget.checked)}
				/>
			</Stack>
		</Box>
	);
}

/** Mantine NumberInput yields string | number; keep the previous value on garbage. */
function toInt(value: string | number, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}
