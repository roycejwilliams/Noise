#!/usr/bin/env bash
set -euo pipefail

# Sync CopatibleClip's CURRENT_PROJECT_VERSION to match the parent app.
# EAS only increments the main target's build number; the App Clip must match.

PBXPROJ="ios/copatible.xcodeproj/project.pbxproj"

# Read the parent app's current build number (first occurrence = main target)
PARENT_VERSION=$(grep -m1 "CURRENT_PROJECT_VERSION" "$PBXPROJ" | grep -oE '[0-9]+')

if [ -z "$PARENT_VERSION" ]; then
  echo "Could not read CURRENT_PROJECT_VERSION from parent app — skipping sync"
  exit 0
fi

echo "Syncing App Clip CURRENT_PROJECT_VERSION to $PARENT_VERSION"

# The App Clip configs don't have CURRENT_PROJECT_VERSION (we removed them),
# so we inject it into the App Clip Debug and Release build setting blocks.
# Match on the App Clip's unique bundle ID line and insert the version above it.
perl -i -0pe "
  s/(PRODUCT_BUNDLE_IDENTIFIER = com\\.copatible\\.v1\\.Clip;)/CURRENT_PROJECT_VERSION = $PARENT_VERSION;\n\t\t\t\t\$1/g
" "$PBXPROJ"

echo "Done — App Clip build number set to $PARENT_VERSION"
