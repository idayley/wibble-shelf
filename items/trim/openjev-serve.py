#!/usr/bin/env python3
"""openjev-serve.py -- a tiny local Jev-compatible judge for Trim.

Trim's worker (items/trim/main.js) asks this server, over HTTP on
127.0.0.1:8791, how likely an old tool output is NOT needed by the agent
anymore. This process:

  1. Loads one local MLX language model once at startup (an Apple-Silicon
     model runtime -- see mlx-lm on PyPI). Loading is the slow part
     (seconds); every request after that reuses the already-loaded model.
  2. Answers two routes, matching the client's contract exactly
     (items/trim/main.js, the `ask()`/`probeHealth()` functions):

       GET  /health         -> 200 {"ok": true, "model": "<name>"}
       POST /v1/systemone   -> 200 {"answers": {"<question>": {"noul": p}, ...}}

     A `/v1/systemone` body looks like:
       {"model": "openjev", "state": "<text>",
        "questions": {"stale": {"type": "noul", "instructions": "<text>"}}}

     Every question must be of type "noul" -- a single probability in
     [0, 1] answering the yes/no question posed by its `instructions`
     text, given `state` as context. A question of any other type is a
     400: this server only knows how to score "noul".

  3. Scores a "noul" question the same way the scratchpad's dev.py scored
     file relevance for semif: build a prompt from the state + the
     question, force the model to answer in exactly one word ("Yes" or
     "No"), and read the probability off the model's own next-token
     logits for those two candidate tokens (a two-way softmax), instead
     of sampling text and trying to parse it. That is what turns a
     next-token distribution into a calibrated [0, 1] score, and it is
     the one piece of dev.py's method this server had to reproduce
     faithfully -- see "Design notes" below for what changed and why.

Design notes (for the next reader, and for task-3-report.md):

  - dev.py's own scoring path shelled out to a `semif-score` CLI
    (`.venv-semif/bin/semif-score --backend mlx --mlx-bits 4 ...`) that
    reloaded the model per invocation -- fine for an offline batch sweep,
    wrong for a server that must hold one model in memory across many
    requests with a lock (the brief's own requirement). This server calls
    the same underlying library (mlx-lm) in-process instead: load once,
    lock around each request, read logits directly. The scoring *method*
    (forced two-way choice, softmax over the two option logits) is
    unchanged; only "spawn a subprocess per question" became "keep the
    model resident and take the lock".
  - The scratchpad's `semif-score` binary and the `semif_phase1` package
    it came from turned out to have no source files left on disk (only
    empty dist-info / __pycache__ husks) -- there was nothing runnable to
    shell out to even if that architecture had been the right one here.
  - Qwen3.5 (the model this was tested against) is a "thinking" model:
    its chat template opens every assistant turn with a <think> block by
    default. Left on, that turns one scoring call into a multi-second
    chain-of-thought before it ever reaches a Yes/No token -- too slow
    for a judge this is meant to consult often. This server disables
    thinking (`enable_thinking=False`) and reads the probability off the
    very next token instead, which answers in well under a second. The
    trade-off is real and measured, not assumed -- see task-3-report.md.
"""

import argparse
import json
import math
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"  # never anything else -- see the brief.
DEFAULT_PORT = 8791
DEFAULT_MODEL = "~/.cache/openjev/qwen35-4b-q4"
MAX_BODY_BYTES = 1_000_000  # generous for Trim's capped state text; keeps a bad client from parking us on a huge read.

# A judge prompt, not Trim's product name -- this server is a generic
# "noul" scorer; only main.js's *instructions* text happens to be about
# tool-output staleness today.
JUDGE_SYSTEM_PROMPT = (
    "You are judging whether one tool result from earlier in an AI coding "
    "agent's session is now safe to discard because the agent has moved "
    "past needing it. You will see the context and a yes/no question "
    "about it. Decide from the context alone whether the agent still "
    "needs to refer back to that exact tool result to finish its current "
    "request, then answer the question as asked."
)


class Judge:
    """Holds the one loaded model and answers noul questions, one at a time."""

    def __init__(self, model_path):
        from mlx_lm.utils import load  # imported lazily so --help doesn't need mlx installed

        self.model_name = os.path.basename(os.path.normpath(model_path)) or model_path
        self.model, self.tokenizer = load(model_path)
        self.yes_id = self._first_token("Yes")
        self.no_id = self._first_token("No")
        self.lock = threading.Lock()

    def _first_token(self, word):
        ids = self.tokenizer.encode(word, add_special_tokens=False)
        if not ids:
            raise RuntimeError(f"tokenizer produced no tokens for {word!r}")
        return ids[0]

    def score_noul(self, state, instructions):
        """Return P(yes) to `instructions`, given `state`, in [0, 1].

        Forces the model's very next token to be its one-word answer (no
        chain-of-thought), then reads a two-way softmax over just the
        "Yes" and "No" token logits at that position -- the same
        forced-choice-via-logits idea dev.py used, done as one in-process
        forward pass instead of a subprocess call.
        """
        import mlx.core as mx

        messages = [
            {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": (
                    f"{state}\n\nQuestion: {instructions}\n\n"
                    "Respond with exactly one word: Yes or No."
                ),
            },
        ]
        prompt = self.tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, tokenize=False, enable_thinking=False
        )
        ids = self.tokenizer.encode(prompt, add_special_tokens=False)
        with self.lock:
            logits = self.model(mx.array(ids)[None])
            last = logits[0, -1]
            yes_logit = last[self.yes_id].item()
            no_logit = last[self.no_id].item()
        # sigmoid(yes - no) == softmax over exactly {yes, no} -- numerically
        # stable and avoids a full-vocab softmax we don't need.
        return 1.0 / (1.0 + math.exp(no_logit - yes_logit))


def make_handler(judge):
    class Handler(BaseHTTPRequestHandler):
        server_version = "openjev-serve/1.0"

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_error_json(self, status, message):
            self._send_json(status, {"error": message})

        def do_GET(self):
            if self.path == "/health":
                self._send_json(200, {"ok": True, "model": judge.model_name})
            else:
                self._send_error_json(404, "not found")

        def do_POST(self):
            if self.path != "/v1/systemone":
                self._send_error_json(404, "not found")
                return

            length_header = self.headers.get("Content-Length")
            try:
                length = int(length_header) if length_header is not None else 0
            except ValueError:
                length = -1
            if length <= 0 or length > MAX_BODY_BYTES:
                self._send_error_json(400, "missing or oversized body")
                # Drain whatever is there so the connection can be reused/closed cleanly.
                if length_header and length_header.isdigit():
                    self.rfile.read(min(int(length_header), MAX_BODY_BYTES))
                return

            raw = self.rfile.read(length)  # never logged, never echoed back.
            try:
                request = json.loads(raw)
            except json.JSONDecodeError:
                self._send_error_json(400, "invalid JSON body")
                return
            finally:
                del raw  # done with the body; nothing below should need it again.

            if not isinstance(request, dict):
                self._send_error_json(400, "body must be a JSON object")
                return

            state = request.get("state", "")
            questions = request.get("questions")
            if not isinstance(questions, dict) or not isinstance(state, str):
                self._send_error_json(400, "expected {state, questions}")
                return

            for name, spec in questions.items():
                if not isinstance(spec, dict) or spec.get("type") != "noul":
                    self._send_error_json(400, f"unsupported question type for {name!r}")
                    return

            answers = {}
            for name, spec in questions.items():
                instructions = spec.get("instructions", "")
                p = judge.score_noul(state, instructions)
                answers[name] = {"noul": p}

            self._send_json(200, {"answers": answers})

        def log_message(self, fmt, *args):
            # Never log request bodies -- only the standard access line
            # (client, request line, status), which BaseHTTPRequestHandler
            # already keeps free of body content.
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"path to a local MLX model directory (default: {DEFAULT_MODEL})",
    )
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    args = parser.parse_args()

    model_path = os.path.expanduser(args.model)
    print(f"[openjev-serve] loading model from {model_path} ...", file=sys.stderr)
    t0 = time.time()
    judge = Judge(model_path)
    print(f"[openjev-serve] loaded {judge.model_name} in {time.time() - t0:.1f}s", file=sys.stderr)

    server = ThreadingHTTPServer((HOST, args.port), make_handler(judge))
    server.daemon_threads = True
    print(f"[openjev-serve] listening on http://{HOST}:{args.port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        print("[openjev-serve] stopped", file=sys.stderr)


if __name__ == "__main__":
    main()
