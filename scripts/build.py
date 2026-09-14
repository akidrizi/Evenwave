#!/usr/bin/env python3
"""Packages the extension into a Chrome Web Store-ready zip.

Usage:
    python scripts/build.py

Produces (at the repo root):
    dist/evenwave/                 unpacked build (point "Load unpacked" here)
    dist/evenwave-<version>.zip    manifest.json at the archive root, ready to
                                    upload to the Chrome Web Store dashboard

Ships exactly SHIP_PATHS below -- an allowlist, not "everything except a
blocklist", since the repo root also holds README/CLAUDE.md/scripts/.git/etc.
that must never end up in the package. Update SHIP_PATHS if you add a new
top-level file the manifest references.
"""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

SHIP_PATHS = ["manifest.json", "content.js", "popup.html", "popup.js", "icons"]


def collect_files():
    files = []
    for entry in SHIP_PATHS:
        path = ROOT / entry
        if path.is_dir():
            files.extend(p for p in path.rglob("*") if p.is_file())
        else:
            files.append(path)
    return files


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    name = manifest["name"].lower()

    unpacked_dir = DIST / name
    zip_path = DIST / f"{name}-{version}.zip"

    if unpacked_dir.exists():
        shutil.rmtree(unpacked_dir)
    unpacked_dir.mkdir(parents=True)

    files = collect_files()
    for src_file in files:
        rel = src_file.relative_to(ROOT)
        dest = unpacked_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, dest)

    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for src_file in files:
            rel = src_file.relative_to(ROOT)
            zf.write(src_file, rel.as_posix())

    print(f"{name} v{version}")
    print(f"  unpacked -> {unpacked_dir.relative_to(ROOT)}  ({len(files)} files)")
    print(f"  zip      -> {zip_path.relative_to(ROOT)}  ({zip_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
