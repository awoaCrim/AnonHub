"""Build single-reply judging items so different sources share one absolute scoring regime.

Groups:
  qq-old-prod      production QQ replies from the replay cases (older prompt versions)
  qq-replay-<v>    replayed replies for the same cases (first run of a variant/model)
  xhh-prod         production Xiaoheihe replies sent after a cutoff timestamp

Usage: python3 -I scripts/voice-replay/items.py <work-dir> <xhh-raw-dir> <cutoff-ms>
         [--replay V1/gemini,KX1/gemini] [--runs 1] [--kind knowledge] [--no-prod] [--out items.jsonl]
Writes <work-dir>/<out>
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def text_of(parts) -> str:
    return "".join(p.get("text") or "" if p.get("type") == "text" else f"[{p.get('type')}]" for p in parts or [])


def sent(content) -> list[str]:
    for part in content if isinstance(content, list) else []:
        if part.get("type") == "tool-call" and part.get("toolName") == "send_message":
            return [p["text"] for p in (part.get("input") or {}).get("parts", []) if p.get("kind", "text") == "text" and p.get("text")]
    return []


def qq_context(case: Path, limit: int = 8) -> str:
    lines = []
    for line in (case / "history.jsonl").read_text(encoding="utf8").splitlines():
        data = json.loads(line).get("data") or {}
        if data.get("type") == "yesimbot.message":
            body = data.get("data") or {}
            lines.append(f"{(body.get('user') or {}).get('name', '某人')}：{text_of(body.get('parts'))}")
        elif data.get("role") == "assistant" and sent(data.get("content")):
            lines.append("爱音：" + " / ".join(sent(data["content"])))
    trigger = (json.loads((case / "trigger.json").read_text(encoding="utf8"))["data"]).get("data") or {}
    lines.append(f"{(trigger.get('user') or {}).get('name', '某人')}（当前消息）：{text_of(trigger.get('parts'))}")
    return "\n".join(line[:400] for line in lines[-limit:])


def xhh_items(raw: Path, cutoff: int) -> list[dict]:
    items = []
    for session in sorted(raw.glob("*/sessions/*.jsonl")):
        rows = []
        for line in session.read_text(encoding="utf8").splitlines():
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        for index, row in enumerate(rows):
            data = row.get("data") or {}
            texts = sent(data.get("content")) if data.get("role") == "assistant" else []
            if not texts or row.get("timestamp", 0) < cutoff:
                continue
            # The visible situation: the latest wake-up event plus the last post/comment read before replying.
            event, reading = "", ""
            for earlier in reversed(rows[:index]):
                earlier_data = earlier.get("data") or {}
                if not event and earlier_data.get("type") == "yesimbot.event":
                    event = json.dumps(earlier_data.get("data"), ensure_ascii=False)[:1500]
                if not reading and earlier_data.get("role") == "tool":
                    for part in earlier_data.get("content") or []:
                        if part.get("toolName", "").startswith(("xiaoheihe_read", "read_post")):
                            reading = json.dumps(part.get("output"), ensure_ascii=False)[:1500]
                if event and reading:
                    break
            context = f"（小黑盒公开社区，对方是陌生网友）\n触发事件：{event or '无'}\n刚读到的内容：{reading or '无'}"
            items.append({"id": f"xhh-{session.parent.parent.name[-12:]}-{index}", "group": "xhh-prod", "context": context, "reply": "\n".join(texts)})
    return items


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("work", type=Path)
    parser.add_argument("xhh", type=Path)
    parser.add_argument("cutoff", type=int)
    parser.add_argument("--replay", default="V1/gemini")
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--kind", default="")
    parser.add_argument("--no-prod", action="store_true")
    parser.add_argument("--out", default="items.jsonl")
    args = parser.parse_args()

    items = []
    for case in sorted((args.work / "cases").iterdir()):
        meta = json.loads((case / "case.json").read_text(encoding="utf8"))
        if args.kind and meta["kind"] != args.kind:
            continue
        context = qq_context(case)
        if not args.no_prod:
            items.append({"id": f"{case.name}-prod", "group": "qq-old-prod", "kind": meta["kind"], "context": context, "reply": "\n".join(meta["reply"])})
        for replay in args.replay.split(","):
            for run in range(1, args.runs + 1):
                output = args.work / "outputs" / replay / f"{case.name}.r{run}.json"
                if not output.exists():
                    continue
                result = json.loads(output.read_text(encoding="utf8"))
                if result.get("action") == "send" and result.get("texts"):
                    tag = replay.replace("/", "-")
                    items.append({"id": f"{case.name}-{tag}-r{run}", "group": f"qq-replay-{tag}", "kind": meta["kind"], "context": context, "reply": "\n".join(result["texts"])})
    if not args.no_prod:
        items += xhh_items(args.xhh, args.cutoff)
    path = args.work / args.out
    path.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in items), encoding="utf8")
    counts: dict[str, int] = {}
    for item in items:
        counts[item["group"]] = counts.get(item["group"], 0) + 1
    print(counts, "->", path)


if __name__ == "__main__":
    main()
