#!/bin/sh
set -e
node src/cli.js --amount 12800 --rate 0.06 --discount 0.05
node src/cli.js --amount 0 || test $? -eq 2
