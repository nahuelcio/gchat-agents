#!/bin/sh
set -eu
REPO="${SWITCHBOARD_REPO:-nahuelcio/gchat-agents}"
DIR="${SWITCHBOARD_DIR:-$HOME/.local/share/switchboard}"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=switchboard-linux-x64 ;;
  Linux-aarch64|Linux-arm64) ASSET=switchboard-linux-arm64 ;;
  Darwin-arm64) ASSET=switchboard-macos-arm64 ;;
  Darwin-x86_64) ASSET=switchboard-macos-x64 ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
mkdir -p "$DIR"
if command -v gh >/dev/null 2>&1; then
  gh release download --repo "$REPO" --pattern "$ASSET" --output "$DIR/switchboard" --clobber
else
  curl -fsSL "https://github.com/$REPO/releases/latest/download/$ASSET" -o "$DIR/switchboard"
fi
chmod +x "$DIR/switchboard"
echo "installed $DIR/switchboard"
echo "run: cd $DIR && ./switchboard   then open http://127.0.0.1:8081"
