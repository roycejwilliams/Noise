#!/usr/bin/env bash
set -euo pipefail

# Sync CopatibleClip's CURRENT_PROJECT_VERSION to match the parent app.
# EAS only increments the main target — this runs after that to keep them in sync.

python3 - <<'PYEOF'
import re, sys

pbxproj = "ios/copatible.xcodeproj/project.pbxproj"

with open(pbxproj, "r") as f:
    content = f.read()

# Find the parent app's CURRENT_PROJECT_VERSION (first occurrence = main target)
m = re.search(r"CURRENT_PROJECT_VERSION = (\d+);", content)
if not m:
    print("WARNING: Could not find CURRENT_PROJECT_VERSION in project — skipping sync")
    sys.exit(0)

version = m.group(1)
print(f"Parent app CURRENT_PROJECT_VERSION = {version}")

# Replace ALL occurrences so App Clip matches parent
updated = re.sub(r"CURRENT_PROJECT_VERSION = \d+;", f"CURRENT_PROJECT_VERSION = {version};", content)

count = len(re.findall(r"CURRENT_PROJECT_VERSION = \d+;", updated))
print(f"Synced {count} CURRENT_PROJECT_VERSION entries to {version}")

with open(pbxproj, "w") as f:
    f.write(updated)
PYEOF
