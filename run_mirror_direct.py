#!/usr/bin/env python3
import os
import sys
from pathlib import Path

# Load .env.deploy
env_path = Path(__file__).parent / ".env.deploy"
if env_path.exists():
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            # Remove surrounding quotes
            if v.startswith('"') and v.endswith('"'):
                v = v[1:-1]
            os.environ[k] = v

# Also ensure HF_TOKEN is set
if "HF_TOKEN" not in os.environ and "HF_API_KEY" in os.environ:
    os.environ["HF_TOKEN"] = os.environ["HF_API_KEY"]

# Now run the actual mirror script
import importlib.util
spec = importlib.util.spec_from_file_location("weights_mirror", Path(__file__).parent / "scripts" / "weights-mirror.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

# Call main with our arguments
sys.argv = ["weights-mirror.py", "--only", "brain", "--yes"]
sys.exit(mod.main())
