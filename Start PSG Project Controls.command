#!/bin/bash
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Download the LTS version from https://nodejs.org and run this again."
  read -p "Press Enter to close"; exit 1
fi
echo "Starting PSG Project Controls... leave this window open while you use it."
(sleep 1.5; open http://localhost:3000) &
node server.js
