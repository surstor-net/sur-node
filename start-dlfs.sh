#!/bin/bash
# SurStor DLFS startup script
# Starts DLFSServer on localhost:8765 if not already running

PORT=8765
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPS_DIR="$SCRIPT_DIR/dlfs/deps"
LOG="$SCRIPT_DIR/dlfs.log"
ERR_LOG="$SCRIPT_DIR/dlfs-err.log"

if curl -s --max-time 2 "http://localhost:$PORT/dlfs/" > /dev/null 2>&1; then
    echo "DLFS already running on port $PORT"
    exit 0
fi

if [ ! -d "$DEPS_DIR" ]; then
    echo "ERROR: deps not found at $DEPS_DIR"
    echo "Make sure the dlfs/deps/ folder is inside your sur-node directory."
    exit 1
fi

nohup java -cp "$DEPS_DIR/*" convex.dlfs.DLFSServer $PORT >> "$LOG" 2>> "$ERR_LOG" &
echo "DLFS started on port $PORT (PID $!)"
