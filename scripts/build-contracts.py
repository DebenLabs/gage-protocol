#!/usr/bin/env python3
"""Build pinned dependencies and Gage without RPC access or signing."""
import os
import subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[1] / "contracts"
env = {**os.environ, "FOUNDRY_PROFILE": "default"}
for relative in ["lib/v4-periphery/lib/v4-core", "lib/v4-periphery/lib/permit2", "lib/v4-periphery"]:
    subprocess.run(["forge", "build", "--skip", "test", "--skip", "script"], cwd=root / relative, env=env, check=True)
subprocess.run(["forge", "build", "--build-info", "--sizes"], cwd=root, check=True)
