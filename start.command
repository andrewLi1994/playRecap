#!/bin/zsh
cd "${0:A:h}"
python3 server.py --host 0.0.0.0 --port 8765
