#!/usr/bin/env python3
"""Check source provenance and the public repository's tracked-file boundary."""
import hashlib
import json
import re
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
entries = subprocess.check_output(["git", "ls-files", "--stage", "-z"], cwd=root).split(b"\0")
tracked = {}
errors = []
for entry in entries:
    if not entry:
        continue
    metadata, name = entry.split(b"\t", 1)
    mode, oid, stage = metadata.decode().split()
    name = name.decode()
    tracked[name] = (mode, oid)
    path = Path(name)
    if stage != "0":
        errors.append(f"Unresolved merge: {name}")
    if mode == "120000":
        errors.append(f"Unreviewed symlink: {name}")
    if path.name.startswith(".env") and path.name != ".env.example":
        errors.append(f"Non-template environment file: {name}")
    forbidden = {".claude", ".agents", "output", "artifacts", "node_modules", ".launch", ".rehearsal", ".vercel", "broadcast"}
    if forbidden.intersection(path.parts) or name.startswith(("docs/security/", "docs/research/", "docs/launch-evidence/")):
        errors.append(f"Private/generated path: {name}")
    if path.suffix.lower() in {".pem", ".key", ".p12", ".pfx", ".sqlite", ".db", ".log"}:
        errors.append(f"Private/generated file type: {name}")
    if mode == "160000":
        continue
    data = (root / name).read_bytes()
    if b"\0" in data:
        errors.append(f"Unexpected binary source file: {name}")
    text = data.decode("utf-8", errors="replace")
    if re.search(r"/(?:Users|home)/[A-Za-z0-9_.-]+/", text):
        errors.append(f"Personal filesystem path: {name}")
    if name.endswith(".sol") and "SPDX-License-Identifier: MIT" not in text.splitlines()[0]:
        errors.append(f"Missing Gage SPDX license: {name}")
    if name.endswith(".md"):
        for target in re.findall(r"\]\(([^)]+)\)", text):
            if "://" in target or target.startswith(("#", "mailto:")):
                continue
            destination = target.split("#", 1)[0]
            if destination and not (root / path.parent / destination).exists():
                errors.append(f"Broken documentation link in {name}: {target}")

manifest = json.loads((root / "SOURCE_MANIFEST.json").read_text())
for row in manifest["files"]:
    path = root / row["path"]
    if row["path"] not in tracked:
        errors.append(f"Source file not tracked: {row['path']}")
    elif hashlib.sha256(path.read_bytes()).hexdigest() != row["export_sha256"]:
        errors.append(f"Source hash changed; update reviewed provenance: {row['path']}")
for row in manifest["submodules"]:
    if tracked.get(row["path"]) != ("160000", row["commit"]):
        errors.append(f"Submodule pin mismatch: {row['path']}")
modules = (root / ".gitmodules").read_text()
if len(re.findall(r"url\s*=\s*https://github.com/(?:foundry-rs|OpenZeppelin|uniswap)/", modules)) != len(manifest["submodules"]):
    errors.append("Unexpected submodule source; review public dependency URLs")
if errors:
    raise SystemExit("\n".join(errors))
print(f"Publication boundary and provenance passed: {len(tracked)} tracked entries, {len(manifest['files'])} source files.")
