#!/bin/sh
# Runs Trim's judge on 127.0.0.1:8791. Wibble starts this when Trim asks
# the judge something and stops it after 10 minutes with no questions.
H="${WIBBLE_HELPER_HOME:?Wibble sets WIBBLE_HELPER_HOME}"
exec "$H/venv/bin/python" openjev-serve.py --model "$H/model"
