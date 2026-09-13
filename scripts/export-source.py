#!/usr/bin/env python3
"""Re-export the reviewed source allowlist; never import Git history or untracked files."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path, PurePosixPath


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args])


def digest(data):
    return hashlib.sha256(data).hexdigest()


def transform(data, operations, public_root, target):
    for operation in operations:
        if operation == "spdx-mit":
            data = data.replace(b"// SPDX-License-Identifier: UNLICENSED", b"// SPDX-License-Identifier: MIT")
        elif operation == "valuation-fixture-import":
            data = data.replace(b"../../../docs/security/tendies-erc20-2026-09-08/candidate-deployment.json", b"./fixtures/tendies-deployment.json")
        elif operation == "receipt-test-resolution":
            data = data.replace(b"../../web/package.json", b"../../services/keeper/package.json")
        elif operation == "uniswap-port-notice":
            prefix = b"// SPDX-License-Identifier: MIT\n// Uniswap-derived portions: see THIRD_PARTY_NOTICES.md and licenses/Uniswap-v4-*-MIT.txt.\n"
            if not data.startswith(prefix):
                data = prefix + data
        elif operation == "public-workspace-lockfile":
            data = (public_root / target).read_bytes()
        else:
            raise ValueError(f"Unknown transformation: {operation}")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_repo", type=Path)
    parser.add_argument("commit")
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    public_root = Path(__file__).resolve().parents[1]
    manifest = json.loads((public_root / "SOURCE_MANIFEST.json").read_text())
    revision = git(args.source_repo, "rev-parse", "--verify", "--end-of-options", args.commit + "^{commit}").decode().strip()
    output = args.output.resolve()
    if output.exists():
        raise SystemExit("Output must not exist; an existing checkout is never overwritten.")
    output.mkdir(parents=True)
    selected = {row["path"] for row in manifest["files"]}
    modules = {row["path"] for row in manifest["submodules"]}
    # Copy only tracked public packaging, never the public checkout's untracked output or .git.
    for name in git(public_root, "ls-files", "-z").decode().split("\0"):
        if not name or name in selected or name in modules or name == "SOURCE_MANIFEST.json":
            continue
        source = public_root / name
        if source.is_symlink():
            raise SystemExit(f"Symlink needs explicit review: {name}")
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
        destination.chmod(source.stat().st_mode & 0o777)
    for row in manifest["files"]:
        name = row["path"]
        source_path = row.get("source_path", name)
        for path in [name, source_path]:
            parsed = PurePosixPath(path)
            if parsed.is_absolute() or ".." in parsed.parts or ".git" in parsed.parts:
                raise SystemExit(f"Invalid manifest path: {path}")
        tree = git(args.source_repo, "ls-tree", revision, "--", source_path).decode()
        if not tree.startswith(("100644 blob ", "100755 blob ")):
            raise SystemExit(f"Expected a regular tracked source file: {source_path}")
        data = git(args.source_repo, "show", f"{revision}:{source_path}")
        row["source_blob"] = tree.split()[2]
        row["source_sha256"] = digest(data)
        data = transform(data, row.get("transformations", []), public_root, name)
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        destination.chmod(0o755 if tree.startswith("100755") else 0o644)
        row["export_sha256"] = digest(data)
    for row in manifest["submodules"]:
        tree = git(args.source_repo, "ls-tree", revision, "--", row["path"]).decode()
        if not tree.startswith("160000 commit "):
            raise SystemExit(f"Expected pinned submodule: {row['path']}")
        row["commit"] = tree.split()[2]
    manifest["source_commit"] = revision
    (output / "SOURCE_MANIFEST.json").write_text(json.dumps(manifest, indent=2) + "\n")
    git(output, "init", "--initial-branch=main")
    git(output, "add", ".gitmodules")
    for row in manifest["submodules"]:
        git(output, "update-index", "--add", "--cacheinfo", f"160000,{row['commit']},{row['path']}")
    print(f"Exported {len(manifest['files'])} source files from {revision}.")
    print("Review package changes, regenerate the workspace lockfile if needed, initialize submodules, and rerun all checks before committing.")


if __name__ == "__main__":
    main()
