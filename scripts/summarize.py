#!/usr/bin/env python3
"""Compact test summary. Reads a test log on stdin (node:test spec output or vitest output) and prints
one line, plus only the failing tests with the first lines of their error. The full log stays on disk."""
import re
import sys

name = sys.argv[1] if len(sys.argv) > 1 else "tests"
log = sys.argv[2] if len(sys.argv) > 2 else ""
text = re.sub(r"\x1b\[[0-9;]*m", "", sys.stdin.read())


def num(pattern):
    m = re.search(pattern, text)
    return int(m.group(1)) if m else None


tests, passed, failed = num(r"ℹ tests (\d+)"), num(r"ℹ pass (\d+)"), num(r"ℹ fail (\d+)")
if tests is None:  # vitest
    passed = num(r"Tests\s+(?:\d+ failed \| )?(\d+) passed")
    failed = num(r"Tests\s+(\d+) failed") or 0
    tests = (passed or 0) + failed
complete = tests is not None and (passed is not None)
status = "PASS" if complete and not failed else "FAIL" if complete else "INCOMPLETE"
extra = ""
if not complete:
    extra = " (no summary: crashed or timed out)"
print("%-8s %-10s %s/%s%s%s" % (name, status, passed if passed is not None else "?", tests if tests is not None else "?", extra, ("   log: " + log) if log and status != "PASS" else ""))

if status == "PASS":
    sys.exit(0)

shown = 0
seen = set()
lines = text.splitlines()
for i, l in enumerate(lines):
    m = re.match(r"\s*(✖|×|FAIL)\s+(.*?)(\s+\(\d[\d.]*ms\))?\s*$", l)
    if not m or "failing tests" in l or m.group(2).startswith("tests/"):
        continue
    title = m.group(2)[:110]
    if title in seen:
        continue
    seen.add(title)
    # first informative line after the failing title anywhere later in the log
    reason = ""
    for j in range(i + 1, min(i + 400, len(lines))):
        if re.search(r"(AssertionError|Error:|expected|Expected|Unable to find|Input:)", lines[j]):
            reason = lines[j].strip()[:200]
            break
    print("  x %s" % title)
    if reason:
        print("      %s" % reason)
    shown += 1
    if shown >= 8:
        print("  ... more failures in the log")
        break
sys.exit(1)
