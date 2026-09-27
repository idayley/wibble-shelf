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
  cut an item that is needed      ~ 1.25 + 0.1 * P
                                  (the re-read is written to cache, and the
                                   extra request that fetches it reads the
                                   whole prompt, P items' worth, from cache;
                                   --prefix-items, default 30: an ~80K-token
                                   prompt over a ~2.7K-token tool output)
  keep a needed / cut an unneeded   0
main.js charges a live re-read the same way (saving()).
For N in {20, 40} it reports the threshold T (cut when notNeeded >= T)
with the lowest total cost over the scored items, next to the cost of the
age rule alone (cut everything). main.js's cutLine(calls) steps on these,
using calls so far as the estimate of N. Only two lines ever run: a
thread's first batch is released at 20-25 calls (the N=20 best), and every
later batch past 25 calls (the N=40 best).

Also reported, for context: AUC (probability a random not-needed item
scores higher "not needed" than a random needed one), and for each
threshold 0.50..0.90:
  wrong cuts = share of truly-needed items with notNeeded >= threshold
  savings    = share of not-needed items with notNeeded >= threshold

--lengths is a second, unrelated mode: how long a thread runs, not how
good the judge is. For every transcript under ~/.claude/projects/*/*.jsonl,
count its main-thread (not sidechain) assistant requests, deduped by
message id (a transcript under 2 such requests is noise and dropped). For
each `n` in 20/40/60/100/200/400, take the median of (that count - n) over
every transcript that reached at least `n` -- how many further requests a
thread this long still typically has left. Prints a JS array literal,
[[20, 105], ...], to paste into main.js as LEFT_TABLE (main.js's left()
interpolates between these points and holds flat past both ends). Reads
only type/isSidechain/message id from each line -- never a message's own
content, per the no-transcript-content rule.

--curve, given --from <scored.jsonl> (rows already scored by --labels/--out
above: this file's own `notNeeded`, next to the original `label`), fits the
judge's raw notNeeded score to a real probability (design doc §2.4): sort
the rows by score, split into 10 equal-count bins, each bin's raw
probability is its share of label == false (truly not needed), then pool
adjacent violators (repeatedly merge neighbouring bins whose probability
would otherwise decrease, into their count-weighted average) so the curve
is non-decreasing in score end to end -- a higher raw score never maps to
a lower probability, though a run of ties can survive unmerged. Prints
`bins` ([[upperScore, prob], ...], the last upper forced to 1 so every
score in [0, 1] lands somewhere) and `baseRate` (the overall share not
needed, main.js's fallback for an item the judge never answered) -- paste
both into main.js's CALIBRATION. main.js's probNotNeeded() looks a
verdict's notNeeded up in these same bins.

Usage (the judge must already be running, except --lengths/--curve, which
need no judge -- they only re-read past transcripts or a scored file):
    python items/trim/calibrate.py --labels sets.json --repo ~/code/wibble \
        --max 400 --minutes 30 --out results.jsonl
    python items/trim/calibrate.py --from results.jsonl   # re-tabulate only
    python items/trim/calibrate.py --lengths
    python items/trim/calibrate.py --curve --from results.jsonl
Stdlib only; no mlx needed here.
"""

import argparse
import glob
import json
import os
import random
import re
import statistics
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
REREAD_WRITE = 1.25  # the re-read text, written to cache
PREFIX_ITEMS = 30  # the extra request's prompt, in item-sized units, read at 0.1
CALLS = (20, 40)

LENGTHS_GLOB = os.path.expanduser("~/.claude/projects/*/*.jsonl")
LENGTHS_N = (20, 40, 60, 100, 200, 400)
CURVE_BINS = 10


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


def cut_needed(prefix_items):
    return REREAD_WRITE + 0.1 * prefix_items


def cost(rows, t, n, prefix_items=PREFIX_ITEMS):
    total = 0.0
    for r in rows:
        cut = r["notNeeded"] >= t
        if cut and r["label"]:
            total += cut_needed(prefix_items)
        elif not cut and not r["label"]:
            total += KEEP_UNNEEDED_PER_CALL * n
    return total


def best_thresholds(rows, prefix_items=PREFIX_ITEMS):
    """{N: (best T, its cost, age-rule-alone cost)} over T = 0.00..1.00 step 0.01.
    Ties go to the lower T (cut more)."""
    grid = [i / 100 for i in range(101)]
    out = {}
    for n in CALLS:
        t = min(grid, key=lambda g: (cost(rows, g, n, prefix_items), g))
        out[n] = (t, cost(rows, t, n, prefix_items), cost(rows, 0.0, n, prefix_items))
    return out


def report(rows, prefix_items=PREFIX_ITEMS):
    lines, n_needed, n_spare = table(rows)
    print(f"items: {len(rows)} ({n_needed} needed, {n_spare} not needed), "
          f"tasks: {len({(r['split'], r['commit']) for r in rows})}")
    print(f"AUC: {auc(rows):.3f}")
    print("threshold | wrong cuts (needed cut) | savings (not-needed cut)")
    for t, w, s in lines:
        print(f"  {t:.2f}    | {w:6.1%}                  | {s:6.1%}")
    print(f"cost model: keep unneeded = {KEEP_UNNEEDED_PER_CALL} x N, "
          f"cut needed = {REREAD_WRITE} + 0.1 x {prefix_items} = {cut_needed(prefix_items):.2f}")
    for n, (t, c, age) in best_thresholds(rows, prefix_items).items():
        print(f"  N={n:<3} best T = {t:.2f}  cost {c:.1f}  (age rule alone {age:.1f}, {1 - c / age:.0%} cheaper)")
    print("main.js cutLine(calls): <= 25 calls (a thread's first batch) -> N=20 best, > 25 -> N=40 best")


def thread_lengths(pattern=LENGTHS_GLOB):
    """One length per transcript: its count of main-thread (not sidechain)
    assistant requests, deduped by message id. Transcripts under 2 such
    requests are skipped -- see the module docstring's --lengths section.
    Never reads a message's own content, only type/isSidechain/id."""
    lens = []
    for path in glob.glob(pattern):
        seen = set()
        count = 0
        try:
            for line in open(path, encoding="utf-8", errors="replace"):
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get("type") != "assistant" or o.get("isSidechain"):
                    continue
                mid = (o.get("message") or {}).get("id")
                if not mid or mid in seen:
                    continue
                seen.add(mid)
                count += 1
        except OSError:
            continue
        if count >= 2:
            lens.append(count)
    return lens


def left_table(lens, ns=LENGTHS_N):
    """[[n, median(len - n) over threads with len >= n], ...], skipping any
    `n` no transcript reached at all."""
    table = []
    for n in ns:
        remaining = [l - n for l in lens if l >= n]
        if remaining:
            table.append([n, round(statistics.median(remaining))])
    return table


def do_lengths():
    lens = thread_lengths()
    print(f"{len(lens)} threads (of {len(glob.glob(LENGTHS_GLOB))} transcripts)", file=sys.stderr)
    print(json.dumps(left_table(lens)))


def pav(bins):
    """Pool adjacent violators: `bins` is [[upper, prob, count], ...] in
    ascending score order. Repeatedly merges a bin into its predecessor
    whenever the predecessor's probability is higher (a violation of
    non-decreasing), replacing the pair with their count-weighted average
    and the later bin's upper bound, until nothing violates any more."""
    stack = []
    for b in bins:
        stack.append(list(b))
        while len(stack) >= 2 and stack[-2][1] > stack[-1][1]:
            hi = stack.pop()
            lo = stack.pop()
            n = lo[2] + hi[2]
            prob = (lo[1] * lo[2] + hi[1] * hi[2]) / n
            stack.append([hi[0], prob, n])  # the higher (later) bin's upper survives
    return stack


def curve_bins(rows, k=CURVE_BINS):
    """10 equal-count bins by ascending notNeeded score; each bin's raw
    probability is its share of label == false (truly not needed), pooled
    (pav()) so probability is non-decreasing in score end to end. The top
    bin's upper is forced to 1 so every score in [0, 1] lands somewhere.
    Returns ([[upper, prob], ...], baseRate)."""
    rows = sorted(rows, key=lambda r: r["notNeeded"])
    n = len(rows)
    base_rate = sum(1 for r in rows if not r["label"]) / n if n else 0.0

    raw = []
    start = 0
    for i in range(k):
        size = n // k + (1 if i < n % k else 0)
        if size == 0:
            continue
        chunk = rows[start : start + size]
        start += size
        not_needed = sum(1 for r in chunk if not r["label"])
        raw.append([chunk[-1]["notNeeded"], not_needed / len(chunk), len(chunk)])
    if raw:
        raw[-1][0] = 1.0

    bins = [[round(u, 4), round(p, 4)] for u, p, _ in pav(raw)]
    return bins, round(base_rate, 4)


def do_curve(path):
    rows = [json.loads(l) for l in open(path) if l.strip()]
    bins, base_rate = curve_bins(rows)
    print(f"{len(rows)} scored items, {sum(1 for r in rows if not r['label'])} not needed", file=sys.stderr)
    print("bins =", json.dumps(bins))
    print("baseRate =", base_rate)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--labels")
    ap.add_argument("--repo", help="git repo the labeled commits live in")
    ap.add_argument("--url", default="http://127.0.0.1:8791/v1/systemone")
    ap.add_argument("--max", type=int, default=400)
    ap.add_argument("--minutes", type=float, default=30)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", help="write one JSON line per scored item")
    ap.add_argument("--from", dest="from_", help="re-tabulate a previous --out file, or (with --curve) fit its curve")
    ap.add_argument("--prefix-items", type=float, default=PREFIX_ITEMS,
                    help="the extra request a wrong cut forces, in item-sized units (default %(default)s)")
    ap.add_argument("--lengths", action="store_true",
                    help="print LEFT_TABLE (a JS array literal) from ~/.claude/projects; needs no judge, no --labels")
    ap.add_argument("--curve", action="store_true",
                    help="with --from <scored.jsonl>, fit and print CALIBRATION's bins/baseRate; needs no judge")
    args = ap.parse_args()

    if args.lengths:
        do_lengths()
        return
    if args.curve:
        if not args.from_:
            ap.error("--curve requires --from <scored.jsonl>")
        do_curve(args.from_)
        return
    if args.from_:
        report([json.loads(l) for l in open(args.from_) if l.strip()], args.prefix_items)
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
    report(rows, args.prefix_items)


if __name__ == "__main__":
    main()
