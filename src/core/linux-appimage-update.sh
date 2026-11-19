#!/bin/sh
# Invoked by the desktop main process. Keep all replacement files on the target filesystem.
set -eu
pid=$1
target=$2
staged=$3
backup=$4
receipt=$5
log=$6
hash=$7
version=$8
exec >>"$log" 2>&1
i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then rm -f -- "$staged"; exit 1; fi
  sleep 1
done
if [ "$(sha256sum < "$staged" | cut -d' ' -f1)" != "$hash" ]; then rm -f -- "$staged"; exit 1; fi
ln -- "$target" "$backup"
mv -fT -- "$staged" "$target"
unset APPIMAGE APPDIR OWD ARGV0
APKSTART_HEALTH_RECEIPT="$receipt" APKSTART_HEALTH_VERSION="$version" "$target" &
child=$!
i=0
while [ "$i" -lt 90 ]; do
  if [ -f "$receipt" ]; then rm -f -- "$receipt" "$backup"; exit 0; fi
  if ! kill -0 "$child" 2>/dev/null; then break; fi
  i=$((i + 1))
  sleep 1
done
echo "AppImage $version failed startup, restoring previous version"
kill "$child" 2>/dev/null || true
wait "$child" 2>/dev/null || true
mv -fT -- "$backup" "$target"
"$target" &
