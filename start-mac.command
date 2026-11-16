#!/bin/bash
# FamilyCFO - double-click (in Finder) to build and start the app, then open it in the browser.
# Close this window (or press Ctrl+C) to stop it. Options: ./start-mac.command --skip-build / --demo / --no-open
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org and run this again."
  read -r -p "Press Enter to close…"
  exit 1
fi

node scripts/start.mjs "$@"
status=$?
if [ $status -ne 0 ]; then
  echo
  echo "FamilyCFO stopped with an error — see the messages above."
  read -r -p "Press Enter to close…"
fi
exit $status
