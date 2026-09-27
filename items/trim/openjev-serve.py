#!/usr/bin/env python3
"""openjev-serve.py -- a tiny local Jev-compatible judge for Trim.

Trim's worker (items/trim/main.js) asks this server, over HTTP on
127.0.0.1:8791, how likely the agent still needs an old tool output
(Trim cuts on 1 - that). This process:

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
        self.lock = threading.Lock()
        self.yes_id, self.no_id = self._pick_answer_tokens()

    def _single_token_variants(self, word):
        """The single-token spellings of `word` ("Yes", " Yes"), as {id: text}."""
        out = {}
        for text in (word, " " + word):
            ids = self.tokenizer.encode(text, add_special_tokens=False)
            if len(ids) == 1:
                out[ids[0]] = text
        return out

    def _pick_answer_tokens(self):
        """Startup self-check: which Yes/No token ids does the chat template
        actually produce first?

        A tokenizer can have both "Yes" and " Yes" as single tokens, and which
        one the model emits right after the assistant header depends on the
        chat template. Reading the logit of a spelling the model never emits
        there would quietly skew every score. So run one probe in the same
        template context score_noul() uses and, for each word, keep the
        single-token spelling the model rates highest at that position.
        Fails loudly (RuntimeError, the server never starts) if a word has no
        single-token spelling at all.
        """
        yes_vars = self._single_token_variants("Yes")
        no_vars = self._single_token_variants("No")
        if not yes_vars or not no_vars:
            raise RuntimeError(
                "openjev-serve self-check: tokenizer has no single-token spelling of "
                f"{'Yes' if not yes_vars else 'No'} (tried 'X' and ' X'); cannot score noul"
            )
        last = self._last_logits("Tool output under question:\nRead README.md", "Is this a question?")
        yes_id = max(yes_vars, key=lambda i: last[i].item())
        no_id = max(no_vars, key=lambda i: last[i].item())
        print(
            f"[openjev-serve] answer tokens: {yes_vars[yes_id]!r}={yes_id} {no_vars[no_id]!r}={no_id}",
            file=sys.stderr,
        )
        return yes_id, no_id

    def _prompt_ids(self, state, instructions):
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
        return self.tokenizer.encode(prompt, add_special_tokens=False)

    def _last_logits(self, state, instructions):
        """Next-token logits right after the assistant header, as one forward pass."""
        import mlx.core as mx

        ids = self._prompt_ids(state, instructions)
        with self.lock:
            logits = self.model(mx.array(ids)[None])
            last = logits[0, -1]
            mx.eval(last)
        return last

    def score_noul(self, state, instructions):
        """Return P(yes) to `instructions`, given `state`, in [0, 1].

        Forces the model's very next token to be its one-word answer (no
        chain-of-thought), then reads a two-way softmax over just the
        "Yes" and "No" token logits at that position -- the same
        forced-choice-via-logits idea dev.py used, done as one in-process
        forward pass instead of a subprocess call.
        """
        last = self._last_logits(state, instructions)
        yes_logit = last[self.yes_id].item()
        no_logit = last[self.no_id].item()
        # sigmoid(yes - no) == softmax over exactly {yes, no} -- numerically
        # stable and avoids a full-vocab softmax we don't need.
        return 1.0 / (1.0 + math.exp(no_logit - yes_logit))


def make_handler(judge):
    class Handler(BaseHTTPRequestHandler):
        server_version = "openjev-serve/1.0"

        def _send_json(self, status, payload, close=False):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            if close:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _send_error_json(self, status, message, close=False):
            self._send_json(status, {"error": message}, close=close)

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
                # Drain what a well-formed but empty/small-enough length says is
                # there, then close either way: with a malformed or oversized
                # length we can't know where this request ends, so the
                # connection can't be reused.
                if length_header and length_header.isdigit() and 0 < int(length_header) <= MAX_BODY_BYTES:
                    self.rfile.read(int(length_header))
                self.close_connection = True
                self._send_error_json(400, "missing, malformed or oversized body", close=True)
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

            # Validate every question before scoring any, so a bad one is a
            # 400 without having spent model time on the good ones.
            todo = []
            for name, spec in questions.items():
                if not isinstance(spec, dict) or spec.get("type") != "noul":
                    self._send_error_json(400, f"unsupported question type for {name!r}")
                    return
                instructions = spec.get("instructions")
                if not isinstance(instructions, str) or not instructions:
                    self._send_error_json(400, f"missing instructions for {name!r}")
                    return
                todo.append((name, instructions))

            answers = {name: {"noul": judge.score_noul(state, text)} for name, text in todo}
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
