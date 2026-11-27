"""Score replay outputs and write the comparison report plus a blind-review sheet.

Layout read from <work-dir>:
  cases/<id>/case.json                      original production reply (variant V0)
  outputs/<variant>/<model>/<id>.r<n>.json  {"texts": [...], "action": "send"|"finish"|"tool:<name>"|"error"}

  judgements/<id>.p<n>.json                 blind character-fidelity scores from judge.mts

Style counts are descriptive only: they are compared with the card's own example dialogue, not
minimised. Character fidelity (judge scores) is the primary measure.

Usage: python3 -I scripts/voice-replay/report.py <work-dir> [--blind-variants V1,V4]
"""

from __future__ import annotations

import argparse
import json
import random
import re
from collections import defaultdict
from pathlib import Path

METRICS: list[tuple[str, object]] = [
    (">80字", lambda t: len(t) > 80),
    ("！", lambda t: "！" in t or "!" in t),
    ("啦", lambda t: "啦" in t),
    ("……", lambda t: "……" in t),
    ("～", lambda t: "～" in t or "~" in t),
    ("句尾～", lambda t: t.rstrip()[-1:] in ("～", "~")),
    ("分点", lambda t: bool(re.search(r"(^|\n)\s*[1-9][\.、]|一个是|一是", t))),
    ("要是", lambda t: "要是" in t),
    ("简单说/主要是/其实是", lambda t: bool(re.search(r"简单说|主要是|其实是", t))),
]


def score(texts: list[str]) -> dict[str, float]:
    if not texts:
        return {}
    row = {name: 100 * sum(1 for t in texts if test(t)) / len(texts) for name, test in METRICS}
    row["平均字数"] = sum(len(t) for t in texts) / len(texts)
    return row


def collect(work: Path) -> dict[tuple[str, str], dict[str, list]]:
    """(variant, model) -> {"knowledge": [(case, text)], "casual": [...], "actions": [...]}"""
    cases = {p.parent.name: json.loads(p.read_text(encoding="utf8")) for p in (work / "cases").glob("*/case.json")}
    table: dict[tuple[str, str], dict[str, list]] = defaultdict(lambda: defaultdict(list))
    for case_id, case in cases.items():
        table[("V0", "production")][case["kind"]].append((case_id, "\n".join(case["reply"])))
        table[("V0", "production")]["actions"].append("send")
    for path in sorted((work / "outputs").glob("*/*/*.json")):
        variant, model = path.parent.parent.name, path.parent.name
        case_id = path.name.split(".")[0]
        result = json.loads(path.read_text(encoding="utf8"))
        bucket = table[(variant, model)]
        bucket["actions"].append(result.get("action", "error"))
        if result.get("action") == "send" and result.get("texts"):
            bucket[cases[case_id]["kind"]].append((case_id, "\n".join(result["texts"])))
    return table


def render(table: dict[tuple[str, str], dict[str, list]]) -> str:
    names = [name for name, _ in METRICS] + ["平均字数"]
    lines = ["| 组合 | 类别 | n | " + " | ".join(names) + " | 发言率 |", "|" + "---|" * (len(names) + 4)]
    for (variant, model), bucket in sorted(table.items()):
        actions = bucket["actions"]
        send_rate = 100 * actions.count("send") / len(actions) if actions else 0
        for kind in ("knowledge", "casual", "all"):
            texts = [t for k in ("knowledge", "casual") if kind in (k, "all") for _, t in bucket[k]]
            row = score(texts)
            cells = [f"{row.get(n, 0):.0f}" + ("" if n == "平均字数" else "%") for n in names]
            lines.append(f"| {variant} {model} | {kind} | {len(texts)} | " + " | ".join(cells) + f" | {send_rate:.0f}% |")
    others = sorted({a for b in table.values() for a in b["actions"] if a != "send"})
    if others:
        lines.append("")
        lines.append("非发言动作统计：")
        for (variant, model), bucket in sorted(table.items()):
            counts = {a: bucket["actions"].count(a) for a in others if bucket["actions"].count(a)}
            if counts:
                lines.append(f"- {variant} {model}: {counts}")
    return "\n".join(lines)


def card_reference(work: Path) -> list[str]:
    """Character lines from the card's example dialogue, the voice the replies should resemble."""
    card = json.loads((work / "raw" / "card.json").read_text(encoding="utf8"))
    speaker = (card.get("nickname") or card.get("name") or "").strip()
    lines = []
    for line in card.get("examples", "").splitlines():
        for mark in ("：", ":"):
            if speaker and line.strip().startswith(speaker + mark):
                lines.append(line.split(mark, 1)[1].strip())
                break
    return lines


def judged(work: Path) -> str:
    cases = {p.parent.name: json.loads(p.read_text(encoding="utf8")) for p in (work / "cases").glob("*/case.json")}
    totals: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for path in sorted((work / "judgements").glob("*.json")):
        record = json.loads(path.read_text(encoding="utf8"))
        kind = cases[record["id"]]["kind"]
        for label, score in record["scores"].items():
            if isinstance(score, dict):
                totals[(label, kind)].append(score)
    if not totals:
        return ""
    lines = ["| 组合 | 类别 | 评分次数 | voice | state | register | 平均 |", "|---|---|---|---|---|---|---|"]
    labels = sorted({label for label, _ in totals})
    for label in labels:
        for kind in ("knowledge", "casual"):
            rows = totals.get((label, kind), [])
            if not rows:
                continue
            means = [sum(float(r.get(d, 0)) for r in rows) / len(rows) for d in ("voice", "state", "register")]
            lines.append(f"| {label} | {kind} | {len(rows)} | " + " | ".join(f"{m:.2f}" for m in means) + f" | {sum(means) / 3:.2f} |")
    return "\n".join(lines)


def blind(work: Path, table, variants: list[str], seed: int) -> None:
    cases = {p.parent.name: json.loads(p.read_text(encoding="utf8")) for p in (work / "cases").glob("*/case.json")}
    rng = random.Random(seed)
    sheet, key = [], {}
    for case_id in sorted(cases):
        options = []
        for (variant, model), bucket in table.items():
            if variant not in variants:
                continue
            for kind in ("knowledge", "casual"):
                # First run only, so each combination contributes one candidate per case.
                match = next((t for cid, t in bucket[kind] if cid == case_id), None)
                if match:
                    options.append((f"{variant} {model}", match))
        if len(options) < 2:
            continue
        rng.shuffle(options)
        trigger = json.loads((work / "cases" / case_id / "trigger.json").read_text(encoding="utf8"))
        parts = (trigger["data"]["data"] or {}).get("parts") or []
        said = "".join(p.get("text") or "" for p in parts if p.get("type") == "text")
        sheet.append(f"## {case_id}（{cases[case_id]['kind']}）\n\n> {said.strip()}\n")
        key[case_id] = {}
        for letter, (label, text) in zip("ABCDEFGHIJ", options):
            sheet.append(f"**{letter}.** {text.strip()}\n")
            key[case_id][letter] = label
    (work / "blind.md").write_text("\n".join(sheet), encoding="utf8")
    (work / "blind-key.json").write_text(json.dumps(key, ensure_ascii=False, indent=2), encoding="utf8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("work", type=Path)
    parser.add_argument("--blind-variants", default="")
    parser.add_argument("--seed", type=int, default=11)
    args = parser.parse_args()
    table = collect(args.work)
    reference = card_reference(args.work)
    if reference:
        table[("V-card", "示例对话")]["casual"].extend(("card", line) for line in reference)
        table[("V-card", "示例对话")]["actions"].extend("send" for _ in reference)
    report = "## 角色贴合度（主指标，盲评）\n\n" + (judged(args.work) or "（尚无评审结果）")
    report += "\n\n## 表达统计（描述性，参照 V-card 示例对话，不以低为好）\n\n" + render(table)
    (args.work / "report.md").write_text(report + "\n", encoding="utf8")
    print(report)
    if args.blind_variants:
        blind(args.work, table, args.blind_variants.split(","), args.seed)
        print(f"blind sheet -> {args.work / 'blind.md'}")


if __name__ == "__main__":
    main()
