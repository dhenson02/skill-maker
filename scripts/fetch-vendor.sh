#!/usr/bin/env bash
# MV3 forbids remotely hosted code, so third-party libs are vendored locally.
set -euo pipefail
cd "$(dirname "$0")/../vendor"
CDN=https://cdn.jsdelivr.net/npm
curl -fsSL -o turndown.js             "$CDN/turndown@7.2.0/dist/turndown.js"
curl -fsSL -o turndown-plugin-gfm.js  "$CDN/turndown-plugin-gfm@1.0.2/dist/turndown-plugin-gfm.js"
curl -fsSL -o jszip.min.js            "$CDN/jszip@3.10.1/dist/jszip.min.js"
ls -l
