#!/usr/bin/env bash
# Download Windows x64 static ffmpeg + ffprobe into resources/win/
# Run this ONCE on Mac before `npm run dist:win`
set -e

DEST="$(cd "$(dirname "$0")/.." && pwd)/resources/win"
mkdir -p "$DEST"

echo "Downloading ffmpeg-static for win32/x64 from npm..."

TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

# Pull just the win32 binary from the ffmpeg-static npm package
cd "$TMP"
npm pack ffmpeg-static@5 --silent 2>/dev/null || npm pack ffmpeg-static --silent

tar -xzf ffmpeg-static-*.tgz

WIN_FFMPEG="$TMP/package/ffmpeg.exe"
if [ -f "$WIN_FFMPEG" ]; then
  cp "$WIN_FFMPEG" "$DEST/ffmpeg.exe"
  echo "✅  Copied ffmpeg.exe to $DEST"
else
  echo "❌  ffmpeg.exe not found in package — ffmpeg-static may not include Windows binary on this host."
  echo "    Download manually from https://github.com/BtbN/FFmpeg-Builds/releases"
  echo "    Extract and place ffmpeg.exe + ffprobe.exe into resources/win/"
  exit 1
fi

echo ""
echo "Now download ffprobe for win32/x64 from ffprobe-static..."
npm pack ffprobe-static --silent

tar -xzf ffprobe-static-*.tgz

WIN_FFPROBE="$TMP/package/bin/win32/x64/ffprobe.exe"
if [ -f "$WIN_FFPROBE" ]; then
  cp "$WIN_FFPROBE" "$DEST/ffprobe.exe"
  echo "✅  Copied ffprobe.exe to $DEST"
else
  echo "❌  ffprobe.exe not found at expected path: $WIN_FFPROBE"
  ls "$TMP/package/bin/" 2>/dev/null || true
  exit 1
fi

echo ""
echo "Done! resources/win/ now contains:"
ls -lh "$DEST"
