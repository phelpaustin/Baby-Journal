#!/usr/bin/env bash
# Everything that can be proven without real servers: config validation, the mount guard, then the real chain.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
"$HERE/validate.sh" /tmp/bj-infra-render
"$HERE/mountguard.sh" /tmp/bj-infra-render
"$HERE/run-chain.sh"
