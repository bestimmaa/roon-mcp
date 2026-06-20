#!/bin/sh
# Launch the Roon MCP server with the working directory pinned to the repo
# root. node-roon-api persists the paired-Core token in ./config.json relative
# to the *current working directory* (see node_modules/node-roon-api/lib.js),
# so an MCP client that spawns the server from elsewhere would otherwise fail to
# find the pairing and silently never connect to the Core. Resolving the path
# from $0 keeps this working even if the checkout moves.
cd "$(dirname "$0")/.." || exit 1
exec node dist/index.js
