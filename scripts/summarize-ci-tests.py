"""Render a bounded GitHub summary without copying test output or error bodies."""

import argparse
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET

MAX_REPORT = 8 * 1024 * 1024
MAX_EVENT_BYTES = 64 * 1024
MAX_EVENT_FILES = 16
MAX_FAILURES = 12


def safe(value):
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return "?"
    return re.sub(r"[^\w .:/()+=\[\]-]", "?", str(value)[:200], flags=re.ASCII)


def junit(path):
    failures = []
    count = 0
    try:
        with path.open("rb") as source:
            data = source.read(MAX_REPORT + 1)
    except OSError:
        return "missing or unreadable", failures, count
    parser = ET.XMLPullParser(events=("end",))
    # JUnit does not need DTDs: do not allow entity expansion from test output.
    if b"<!DOCTYPE" in data or b"\x00" in data:
        return "unsupported XML", failures, count
    state = "complete"
    try:
        for offset in range(0, min(len(data), MAX_REPORT), 8192):
            parser.feed(data[offset:min(offset + 8192, MAX_REPORT)])
            for _, element in parser.read_events():
                if element.tag != "testcase":
                    continue
                failure = next((child for child in element if child.tag in ("failure", "error")), None)
                if failure is not None:
                    count += 1
                    if len(failures) < MAX_FAILURES:
                        label = "timeout" if re.search(r"timed?\s*out|timeout", (failure.get("message", "") + (failure.text or ""))[:2048], re.I) else failure.tag
                        failures.append([element.get(key, "?") for key in ("file", "classname", "name", "time")] + [label])
                element.clear()
        parser.close()
    except ET.ParseError:
        state = "truncated, malformed or incomplete"
    if len(data) > MAX_REPORT:
        state = "size limit reached; partial results"
    return state, failures, count


def events(directory, pattern):
    records = []
    for index, path in enumerate(directory.glob(pattern)):
        if index >= MAX_EVENT_FILES:
            break
        if path.is_symlink() or not path.is_file():
            continue
        try:
            with path.open("rb") as stream:
                size = stream.seek(0, 2)
                stream.seek(max(0, size - MAX_EVENT_BYTES))
                if size > MAX_EVENT_BYTES:
                    stream.readline(MAX_EVENT_BYTES)
                for line in stream.read(MAX_EVENT_BYTES).splitlines():
                    try:
                        row = json.loads(line)
                    except (ValueError, RecursionError):
                        continue
                    if isinstance(row, dict):
                        records.append(row)
        except OSError:
            continue
    return sorted(records, key=lambda row: safe(row.get("timestamp", "")))


def incomplete_stages(rows):
    active = {}
    for row in rows:
        if not isinstance(row.get("phase"), str):
            continue
        key = tuple(safe(row.get(field)) for field in ("pid", "phase", "attempt"))
        if row.get("event") == "start":
            active.pop(key, None)
            active[key] = row
        elif row.get("event") in ("end", "error", "retry"):
            active.pop(key, None)
    return list(active.values())[-6:]


def render(directory, shard):
    state, failures, count = junit(directory / "ci-tests.xml")
    output = [f"### Test shard {safe(shard)} diagnostics", "", f"JUnit: **{state}**; failed entries found: **{count}**."]
    for file, suite, name, elapsed, label in failures:
        output.append(f"- `{safe(file)}` · `{safe(suite)} / {safe(name)}` · {safe(label)} · {safe(elapsed)} s")
    if count > len(failures):
        output.append(f"- {count - len(failures)} more entries not shown.")
    stages = events(directory, "ci-stage*.jsonl")
    stage_keys = ("phase", "event", "pid", "attempt", "durationMs")
    for heading, rows, keys in (
        ("Runner events", events(directory, "native-tests*-diagnostics.jsonl")[-6:], ("event", "failure", "reason", "elapsedMs", "exitCode", "signal", "lastOutputElapsedMs", "stdoutBytes", "stderrBytes")),
        ("Fixture stages with no recorded end", incomplete_stages(stages), stage_keys),
        ("Recent fixture stages", stages[-6:], stage_keys),
    ):
        output.extend(["", f"**{heading}**"])
        if not rows:
            output.append("- No records available. Check the live job log and shard artifact.")
        for row in rows:
            fields = [f"{key}: `{safe(row[key])}`" for key in keys if key in row]
            if fields:
                output.append("- " + " · ".join(fields))
    return "\n".join(output) + "\n"


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--artifacts", type=Path, required=True)
    cli.add_argument("--shard", required=True)
    args = cli.parse_args()
    print(render(args.artifacts, args.shard), end="")


if __name__ == "__main__":
    main()
