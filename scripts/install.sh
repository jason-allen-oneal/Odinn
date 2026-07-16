#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/install.mjs" install --source "$(dirname "$SCRIPT_DIR")" "$@"
