#!/bin/zsh
set -euo pipefail
: "${TEAM_ID:?Set TEAM_ID to the existing Xcode development team ID}"
: "${DEVICE_ID:?Set DEVICE_ID to the connected iPhone identifier from xcrun devicectl list devices}"
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
xcodebuild -project ios/LookaheadRemote.xcodeproj -scheme LookaheadRemote \
  -configuration Debug -destination "id=$DEVICE_ID" \
  -derivedDataPath ios/build-signed -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic build
xcrun devicectl device install app --device "$DEVICE_ID" \
  ios/build-signed/Build/Products/Debug-iphoneos/LookaheadRemote.app
xcrun devicectl device process launch --device "$DEVICE_ID" com.lookahead.remote
