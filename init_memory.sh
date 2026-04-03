#!/bin/bash
# AI Memory — auto-init for this project
set -e

# Ensure Redis is running
if ! redis-cli ping > /dev/null 2>&1; then
    echo "Starting Redis..."
    sudo service redis-server start
fi

# Run project setup
python3 "$HOME/.ai-memory/setup_project.py" --project-dir "$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "✅ Memory ready for this project!"
echo "Usage: python3 -c \""
echo "  import sys; sys.path.insert(0, '$HOME/.ai-memory')"
echo "  from memory_core import ProjectMemory"
echo "  mem = ProjectMemory('zombie-monitor')"
echo "  mem.facts.remember('key', 'value')"
echo "\""
