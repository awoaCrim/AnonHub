"""Pick replay cases from copied channel sessions.

A case is a delivered reply whose first model step was a direct send_message, paired with the
user message that triggered it. The session is cut just before that message so capture can feed
it back through the real ChannelRuntime.

Usage: python3 -I scripts/voice-replay/extract.py <raw-dir> <out-dir> [--per-kind 20] [--seed 7]
"""

from __future__ import annotations

import argparse
import json
import random
import re
import shutil
from pathlib import Path

KNOWLEDGE = re.compile(r"https?://|\d{2,}|[A-Za-z]{3,}.*[A-Za-z]{3,}|(^|\s)[1-9][\.、]|一个是|一是")


def load(path: Path) -> list[dict]:
    rows = []
    for line in path.read_text(encoding="utf8").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            # A copy taken while the bot was writing can end in a partial line.
            continue
    return rows


def data(row: dict) -> dict:
    return row.get("data") or {}


def is_user_message(row: dict) -> bool:
    return row.get("type") == "message" and data(row).get("type") == "yesimbot.message"


def send_texts(row: dict) -> list[str] | None:
    d = data(row)
    if d.get("role") != "assistant" or not isinstance(d.get("content"), list):
        return None
    for part in d["content"]:
        if part.get("type") == "tool-call" and part.get("toolName") == "send_message":
            return [p["text"] for p in (part.get("input") or {}).get("parts", []) if p.get("kind", "text") == "text" and p.get("text")]
    return None


def delivered(rows: list[dict], start: int) -> bool:
    for row in rows[start + 1 : start + 4]:
        d = data(row)
        if d.get("role") == "tool":
            for part in d.get("content", []):
                value = ((part.get("output") or {}).get("value")) or {}
                return value.get("ok") is not False
    return False


def has_text(message: dict) -> bool:
    parts = (data(message).get("data") or {}).get("parts") or []
    return any(p.get("type") == "text" and (p.get("text") or "").strip() for p in parts)


def dangling_calls(rows: list[dict]) -> set[str]:
    calls, results = set(), set()
    for row in rows:
        for part in data(row).get("content") or [] if isinstance(data(row).get("content"), list) else []:
            if part.get("type") == "tool-call":
                calls.add(part.get("toolCallId"))
            elif part.get("type") == "tool-result":
                results.add(part.get("toolCallId"))
    return calls - results


def candidates(channel: Path) -> list[dict]:
    found = []
    sessions = sorted((channel / "sessions").glob("*.jsonl"))[-2:]
    for session in sessions:
        rows = load(session)
        trigger = None
        for index, row in enumerate(rows):
            if is_user_message(row):
                trigger = index
                continue
            if data(row).get("role") != "assistant":
                continue
            texts = send_texts(row)
            # Only the first assistant step after the trigger counts; tool-first turns are skipped.
            # A trigger that lands between a tool call and its result belongs to a still-running turn.
            if trigger is not None and texts and delivered(rows, index) and has_text(rows[trigger]) and not dangling_calls(rows[:trigger]):
                reply = "\n".join(texts)
                if not reply.startswith("<img") and "<file" not in reply:
                    kind = "knowledge" if len(reply) > 120 or KNOWLEDGE.search(reply) else "casual"
                    found.append({"channel": channel.name, "session": session.name, "cut": trigger, "reply": texts, "kind": kind})
            trigger = None
    return found


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("raw", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--per-kind", type=int, default=20)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    pool = [case for channel in sorted((args.raw / "channels").iterdir()) for case in candidates(channel)]
    rng = random.Random(args.seed)
    picked = []
    for kind in ("knowledge", "casual"):
        group = [case for case in pool if case["kind"] == kind]
        rng.shuffle(group)
        # Round-robin across channels so one busy group does not dominate the set.
        by_channel: dict[str, list[dict]] = {}
        for case in group:
            by_channel.setdefault(case["channel"], []).append(case)
        while len([c for c in picked if c["kind"] == kind]) < args.per_kind and any(by_channel.values()):
            for queue in by_channel.values():
                if queue and len([c for c in picked if c["kind"] == kind]) < args.per_kind:
                    picked.append(queue.pop())

    cases_dir = args.out / "cases"
    shutil.rmtree(cases_dir, ignore_errors=True)
    for number, case in enumerate(picked):
        case_id = f"{case['kind'][0]}{number:02d}"
        target = cases_dir / case_id
        target.mkdir(parents=True)
        source = args.raw / "channels" / case["channel"]
        rows = [json.dumps(row, ensure_ascii=False) for row in load(source / "sessions" / case["session"])]
        (target / "history.jsonl").write_text("\n".join(rows[: case["cut"]]) + "\n", encoding="utf8")
        (target / "trigger.json").write_text(rows[case["cut"]], encoding="utf8")
        shutil.copy(source / "channel.json", target / "channel.json")
        meta = {"id": case_id, "kind": case["kind"], "channel": case["channel"], "session": case["session"], "reply": case["reply"]}
        (target / "case.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf8")
    counts = {kind: len([c for c in picked if c["kind"] == kind]) for kind in ("knowledge", "casual")}
    print(f"pool={len(pool)} picked={counts} -> {cases_dir}")


if __name__ == "__main__":
    main()
