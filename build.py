#!/usr/bin/env python3
"""Packages extension/ into a Chrome Web Store-ready zip.

Usage:
    python build.py

Produces:
    dist/evenwave/            unpacked build (point "Load unpacked" here)
    dist/evenwave-<version>.zip   manifest.json at the archive root, ready to
                                   upload to the Chrome Web Store dashboard

Only ships runtime files. Dev-only assets (the icon generator script and its
oversized master PNG) are left out on purpose -- they're checked into
extension/icons/ for reproducibility but have no reason to ship.
"""
import json
import shutil
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "extension"
DIST = ROOT / "dist"

EXCLUDE_NAMES = {"make_icons.py", "icon512.png", "__pycache__", ".DS_Store", "Thumbs.db"}
EXCLUDE_SUFFIXES = {".pyc"}


def should_skip(path: Path) -> bool:
    return path.name in EXCLUDE_NAMES or path.suffix in EXCLUDE_SUFFIXES


def collect_files():
    files = []
    for path in SRC.rglob("*"):
        if path.is_dir():
            continue
        parts = path.relative_to(SRC).parts
        if any(part in EXCLUDE_NAMES for part in parts):
            continue
        if should_skip(path):
            continue
        files.append(path)
    return files


def main():
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    name = manifest["name"].lower()

    unpacked_dir = DIST / name
    zip_path = DIST / f"{name}-{version}.zip"

    if unpacked_dir.exists():
        shutil.rmtree(unpacked_dir)
    unpacked_dir.mkdir(parents=True)

    files = collect_files()
    for src_file in files:
        rel = src_file.relative_to(SRC)
        dest = unpacked_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, dest)

    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for src_file in files:
            rel = src_file.relative_to(SRC)
            zf.write(src_file, rel.as_posix())

    print(f"{name} v{version}")
    print(f"  unpacked -> {unpacked_dir.relative_to(ROOT)}  ({len(files)} files)")
    print(f"  zip      -> {zip_path.relative_to(ROOT)}  ({zip_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
