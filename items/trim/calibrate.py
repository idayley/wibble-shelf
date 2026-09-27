#!/usr/bin/env python3
"""calibrate.py -- pick Trim's cutLine(calls) thresholds from labeled past work.

What it measures: for past tasks where we know which files the agent
actually needed, ask the real judge (openjev-serve.py) the exact question
Trim asks, with a `state` built the exact way main.js builds it, and see
how well "not needed" scores separate the truly-needed files from the rest.

Input (--labels): a JSON dict of splits ({"dev": [...], "verify": [...]}),
each a list of items:
    {"commit": "<sha>", "task": "<commit message>", "path": "<file>",
     "head": "<first chars of the file, optional>", "label": true|false}
`label` is true when the file was actually needed for that task.

The state for one item mirrors main.js's stateText():
    Operator's latest request:   the task text (capped at 1500 chars)
    Agent's recent messages:     empty (past tasks have none to replay)
    Tool output under question:  "Read <path>" + the file's first 1200
                                 chars at the commit's parent
                                 (`git -C <repo> show <commit>^:<path>`),
                                 falling back to the item's stored `head`,
                                 then "(content not shown)".
The question text is read out of main.js (JUDGE_QUESTION), so this can't
drift from what Trim actually sends. notNeeded = 1 - noul, as in main.js.

The objective: minimise the expected cost of the judge's decisions.
Trim cuts every aged item the judge has no verdict on anyway (the age
rule), so the judge's only real job is deciding what to KEEP. Per unit of
item size:
  keep an item that isn't needed  ~ 0.1 * N  (a cache read on each of the
                                              N later calls it rides along)
  cut an item that is needed      ~ 1.25     (it gets re-read and re-cached)
  keep a needed / cut an unneeded   0
For N in {10, 20, 40} it reports the threshold T (cut when notNeeded >= T)
with the lowest total cost over the scored items, next to the cost of the
age rule alone (cut everything). main.js's cutLine(calls) steps on these,
using calls so far as the estimate of N: <= 10 calls -> the N=10 best,
11-25 -> the N=20 best, past 25 -> no judge (pure age rule), because at
N=40 no threshold beat the age rule on the neutral-prompt run.

Also reported, for context: AUC (probability a random not-needed item
scores higher "not needed" than a random needed one), and for each
threshold 0.50..0.90:
  wrong cuts = share of truly-needed items with notNeeded >= threshold
  savings    = share of not-needed items with notNeeded >= threshold

Usage (the judge must already be running):
    python items/trim/calibrate.py --labels sets.json --repo ~/code/wibble \
        --max 400 --minutes 30 --out results.jsonl
    python items/trim/calibrate.py --from results.jsonl   # re-tabulate only
Stdlib only; no mlx needed here.
"""

import argparse
import json
import os
import random
import re
import subprocess
import sys
import time
import urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
CAP_LAST_USER = 1500
CAP_RECENT_ASSISTANT = 1500
CAP_HEAD = 1200
THRESHOLDS = [round(0.5 + 0.05 * i, 2) for i in range(9)]
KEEP_UNNEEDED_PER_CALL = 0.1  # x N later calls
CUT_NEEDED = 1.25
CALLS = (10, 20, 40)


def judge_question():
    src = open(os.path.join(HERE, "main.js"), encoding="utf-8").read()
    m = re.search(r'export const JUDGE_QUESTION =\s*"((?:[^"\\]|\\.)*)"', src)
    if not m:
        sys.exit("calibrate: couldn't find JUDGE_QUESTION in main.js")
    return json.loads('"' + m.group(1) + '"')


def file_head(repo, commit, path, stored):
    if repo:
        try:
            out = subprocess.run(
                ["git", "-C", repo, "show", f"{commit}^:{path}"],
                capture_output=True, timeout=10,
            )
            if out.returncode == 0:
                return out.stdout.decode("utf-8", "replace")[:CAP_HEAD], "git"
        except (OSError, subprocess.TimeoutExpired):
            pass
    if stored:
        return stored[:CAP_HEAD], "stored"
    return None, "none"


def state_text(task, path, head):
    return (
        "Operator's latest request:\n" + task[:CAP_LAST_USER]
        + "\n\nAgent's recent messages:\n" + ""
        + "\n\nTool output under question:\nRead " + path + "\n"
        + (head if head is not None else "(content not shown)")
    )


def ask(url, state, question):
    body = json.dumps({
        "model": "openjev", "state": state,
        "questions": {"stale": {"type": "noul", "instructions": question}},
    }).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as res:
        return json.loads(res.read())["answers"]["stale"]["noul"]


def sample(splits, n, seed):
    """Round-robin across tasks (commits), shuffled within each, so no one
    big task dominates the sample."""
    by_task = defaultdict(list)
    for split, items in splits.items():
        for it in items:
            by_task[(split, it["commit"])].append(dict(it, split=split))
    rng = random.Random(seed)
    queues = list(by_task.values())
    for q in queues:
        rng.shuffle(q)
    rng.shuffle(queues)
    out = []
    while len(out) < n and any(queues):
        for q in queues:
            if q and len(out) < n:
                out.append(q.pop())
    return out


def auc(rows):
    pos = [r["notNeeded"] for r in rows if not r["label"]]  # truly not needed
    neg = [r["notNeeded"] for r in rows if r["label"]]      # truly needed
    if not pos or not neg:
        return float("nan")
    wins = sum((p > q) + 0.5 * (p == q) for p in pos for q in neg)
    return wins / (len(pos) * len(neg))


def table(rows):
    needed = [r for r in rows if r["label"]]
    spare = [r for r in rows if not r["label"]]
    lines = []
    for t in THRESHOLDS:
        wrong = sum(r["notNeeded"] >= t for r in needed) / max(1, len(needed))
        save = sum(r["notNeeded"] >= t for r in spare) / max(1, len(spare))
        lines.append((t, wrong, save))
    return lines, len(needed), len(spare)


def cost(rows, t, n):
    total = 0.0
    for r in rows:
        cut = r["notNeeded"] >= t
        if cut and r["label"]:
            total += CUT_NEEDED
        elif not cut and not r["label"]:
            total += KEEP_UNNEEDED_PER_CALL * n
    return total


def best_thresholds(rows):
    """{N: (best T, its cost, age-rule-alone cost)} over T = 0.00..1.00 step 0.01.
    Ties go to the lower T (cut more)."""
    grid = [i / 100 for i in range(101)]
    out = {}
    for n in CALLS:
        t = min(grid, key=lambda g: (cost(rows, g, n), g))
        out[n] = (t, cost(rows, t, n), cost(rows, 0.0, n))
    return out


def report(rows):
    lines, n_needed, n_spare = table(rows)
    print(f"items: {len(rows)} ({n_needed} needed, {n_spare} not needed), "
          f"tasks: {len({(r['split'], r['commit']) for r in rows})}")
    print(f"AUC: {auc(rows):.3f}")
    print("threshold | wrong cuts (needed cut) | savings (not-needed cut)")
    for t, w, s in lines:
        print(f"  {t:.2f}    | {w:6.1%}                  | {s:6.1%}")
    print(f"cost model: keep unneeded = {KEEP_UNNEEDED_PER_CALL} x N, cut needed = {CUT_NEEDED}")
    for n, (t, c, age) in best_thresholds(rows).items():
        print(f"  N={n:<3} best T = {t:.2f}  cost {c:.1f}  (age rule alone {age:.1f}, {1 - c / age:.0%} cheaper)")
    print("main.js cutLine(calls) rule (calls so far estimate N): <=10 calls -> N=10 best, "
          "11-25 -> N=20 best, >25 -> no judge (age rule), when N=40's best doesn't beat the age rule")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels")
    ap.add_argument("--repo", help="git repo the labeled commits live in")
    ap.add_argument("--url", default="http://127.0.0.1:8791/v1/systemone")
    ap.add_argument("--max", type=int, default=400)
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", help="write one JSON line per scored item")
    ap.add_argument("--from", dest="from_", help="re-tabulate a previous --out file")
    args = ap.parse_args()

    if args.from_:
        report([json.loads(l) for l in open(args.from_) if l.strip()])
        return
    if not args.labels:
        ap.error("--labels is required unless --from is given")

    question = judge_question()
    items = sample(json.load(open(args.labels)), args.max, args.seed)
    deadline = time.time() + args.minutes * 60
    out = open(args.out, "w") if args.out else None
    rows = []
    for i, it in enumerate(items):
        if time.time() > deadline:
            print(f"time box hit after {i} items", file=sys.stderr)
            break
        head, head_src = file_head(args.repo, it["commit"], it["path"], it.get("head"))
        noul = ask(args.url, state_text(it["task"], it["path"], head), question)
        row = {"split": it["split"], "commit": it["commit"], "path": it["path"],
               "label": bool(it["label"]), "head_src": head_src,
               "noul": noul, "notNeeded": 1 - noul}
        rows.append(row)
        if out:
            out.write(json.dumps(row) + "\n")
            out.flush()
        if (i + 1) % 25 == 0:
            print(f"{i + 1}/{len(items)}", file=sys.stderr)
    report(rows)


if __name__ == "__main__":
    main()
