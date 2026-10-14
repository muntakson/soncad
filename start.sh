#!/usr/bin/env bash
cd "$(dirname "$0")" && exec python3 -m uvicorn main:app --host 0.0.0.0 --port 3002 --reload
