#!/bin/sh
# Packs harness/ with only its runtime deps into switchboard-harness.tar.gz (pure JS, one archive for every platform).
set -eu
OUT="${1:-switchboard-harness.tar.gz}"
STAGE="$(mktemp -d)"
cp -r harness "$STAGE/"
node -e '
const p = require("./package.json");
const keep = ["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-codemode", "@earendil-works/pi-durable", "typebox", "ws"];
require("fs").writeFileSync(process.argv[1] + "/package.json", JSON.stringify({ name: "switchboard-harness", private: true, type: "module", dependencies: Object.fromEntries(keep.map((k) => [k, p.dependencies[k]])) }, null, 2));
' "$STAGE"
(cd "$STAGE" && npm install --omit=dev --ignore-scripts --no-audit --no-fund)
tar czf "$OUT" -C "$STAGE" harness node_modules package.json
rm -rf "$STAGE"
echo "packed $OUT"
