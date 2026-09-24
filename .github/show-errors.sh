#!/usr/bin/env bash
# Usage: show-errors.sh <logfile> <exit-code>
# When the command failed, copies its error lines into GitHub annotations
# (readable on the run page without signing in), then fails the step.
log="$1"; code="$2"
[ "$code" = "0" ] && exit 0
lines=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | grep -iE "✘|error|denied|not found|permission|authenticat|invalid|forbidden|code: [0-9]+" | grep -viE "^npm (warn|notice)" | head -n 15)
[ -z "$lines" ] && lines=$(sed -E 's/\x1b\[[0-9;]*m//g' "$log" | tail -n 8)
while IFS= read -r line; do [ -n "$line" ] && echo "::error::${line//%/%25}"; done <<< "$lines"
exit "$code"
