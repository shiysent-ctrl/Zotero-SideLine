"""Prepare Sideline release artifacts from an explicit publication allowlist.

Input: project files relative to this script; --list inspects, --verify validates.
Output: a new runtime/release-* directory with sources, XPI and checksums.
Dependencies: Python standard library, Node and Windows PowerShell for validation.
No inference, credential reading, historical cleanup, Git changes or uploads.
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent.parent
ROOT_FILES = (
    "README.md", "AGENTS.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CHANGELOG.md",
    ".gitignore", ".gitattributes", "updates.json",
)
DOC_FILES = ("设计.md", "验收.md", "接口.md", "清理审计.md")
TREE_TYPES = {
    "src": {".js", ".json", ".xhtml", ".css", ".svg", ".woff2", ".md"},
    "test": {".mjs", ".md"},
    "scripts": {".ps1", ".py"},
    ".github/workflows": {".yml"},
}
FIXED_TIME = (2026, 1, 1, 0, 0, 0)
SELECTED_UPDATE_URL = "https://raw.githubusercontent.com/shiysent-ctrl/Zotero-SideLine/main/updates.json"


def validate_install_manifest(manifest):
    """Check required Zotero fields and XPIDatabase's secure-update constraint.

    The URL comes only from the reviewed manifest. This guard never fabricates a
    hosting address, changes host security preferences, or claims URL reachability.
    """
    zotero = manifest.get("applications", {}).get("zotero", {})
    for field in ("id", "update_url", "strict_max_version"):
        if not isinstance(zotero.get(field), str) or not zotero[field].strip():
            raise ValueError(f"Missing Zotero installation field: applications.zotero.{field}")
    url = zotero["update_url"]
    parsed = urlsplit(url)
    if (url != SELECTED_UPDATE_URL or not url.startswith("https://") or not parsed.hostname or parsed.username
            or parsed.password or "update_url" in manifest):
        raise ValueError("Zotero installation requires the explicitly selected HTTPS update URL")


def validate_update_manifest(data, plugin_id):
    if data != {"addons": {plugin_id: {"updates": []}}}:
        raise ValueError("First release update manifest must contain only this plugin ID with no update candidates")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def files_to_publish():
    """Never include ignored artifacts just because they exist on this machine."""
    selected = []
    for name in ROOT_FILES:
        selected.append(ROOT / name)
    selected.extend(ROOT / "docs" / name for name in DOC_FILES)
    for tree, suffixes in TREE_TYPES.items():
        directory = ROOT / tree
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError(f"Missing or linked publication directory: {tree}")
        for entry in directory.rglob("*"):
            if entry.is_symlink():
                raise ValueError(f"Symlink not allowed in publication tree: {entry.relative_to(ROOT)}")
            if not entry.is_file():
                continue
            relative = entry.relative_to(ROOT)
            if "__pycache__" in relative.parts or entry.suffix == ".pyc":
                continue
            if entry.name.lower() in {"auth.json", "credentials.json", "credential.json", ".env"}:
                raise ValueError(f"Private configuration cannot be published: {relative}")
            if entry.suffix not in suffixes and entry.name != "LICENSE":
                raise ValueError(f"Unreviewed publication file type: {relative}")
            selected.append(entry)
    for entry in selected:
        if not entry.is_file() or entry.is_symlink() or not entry.resolve().is_relative_to(ROOT):
            raise ValueError(f"Missing or unsafe publication file: {entry.relative_to(ROOT)}")
    return sorted(set(selected), key=lambda item: item.relative_to(ROOT).as_posix())


def archive_files(output, source, selected):
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for entry in selected:
            name = entry.relative_to(source).as_posix()
            info = zipfile.ZipInfo(name, date_time=FIXED_TIME)
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            archive.writestr(info, entry.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)


def verify_xpi(package, source):
    expected = {entry.relative_to(source).as_posix(): entry.read_bytes()
                for entry in source.rglob("*") if entry.is_file()}
    with zipfile.ZipFile(package) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or set(names) != set(expected):
            raise ValueError("XPI file manifest differs from source tree")
        for name, contents in expected.items():
            if archive.read(name) != contents:
                raise ValueError(f"XPI bytes differ from source: {name}")
    return len(expected)


def run_checked(cwd, script, output_dir, extra=()):
    command = ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(cwd / "scripts" / script), *extra]
    result = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (output_dir / f"{Path(script).stem}.log").write_bytes(result.stdout)
    if result.returncode:
        raise RuntimeError(f"{script} failed; inspect local {Path(script).stem}.log")
    print(f"PASS {script}", flush=True)
    return result.stdout.decode("utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="Print publication allowlist without writing")
    parser.add_argument("--verify", action="store_true", help="Check, test and double-build the standalone export")
    args = parser.parse_args()
    selected = files_to_publish()
    if args.list:
        print("\n".join(entry.relative_to(ROOT).as_posix() for entry in selected))
        return
    manifest = json.loads((ROOT / "src/manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Unsafe release version")
    validate_install_manifest(manifest)
    validate_update_manifest(json.loads((ROOT / "updates.json").read_text(encoding="utf-8")),
                             manifest["applications"]["zotero"]["id"])
    if (ROOT / "src/LICENSE").read_bytes() != (ROOT / "LICENSE").read_bytes():
        raise ValueError("Packaged MIT LICENSE differs from root LICENSE")
    runtime = ROOT / "runtime"
    if runtime.is_symlink():
        raise ValueError("runtime must not be a symlink")
    runtime.mkdir(exist_ok=True)
    if not runtime.resolve().is_relative_to(ROOT):
        raise ValueError("runtime resolves outside project")
    output = runtime / f"release-{version}-{uuid.uuid4().hex[:12]}"
    if not output.resolve().is_relative_to(runtime.resolve()):
        raise ValueError("Release output escaped runtime")
    output.mkdir()  # Exclusive creation; never delete or reuse historical files.
    clean = output / "source"
    clean.mkdir()
    for entry in selected:
        destination = clean / entry.relative_to(ROOT)
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(entry, destination)
    summary = {"version": version, "sourceFiles": len(selected), "verified": False,
               "modelCalls": False, "zoteroUI": "not performed", "platform": "Windows + Zotero 10"}
    if args.verify:
        if not shutil.which("powershell") or not shutil.which("node") or not shutil.which("python"):
            raise ValueError("Verification requires Windows PowerShell, Node and Python on PATH")
        tools = {name: subprocess.check_output(command, text=True).strip()
                 for name, command in {"node": ["node", "--version"], "python": ["python", "--version"]}.items()}
        # Check/test do not load CLI probes, external Skills, user data or real models.
        run_checked(clean, "check.ps1", output)
        run_checked(clean, "test.ps1", output)
        first = clean / "runtime/first/candidate.xpi"
        second = clean / "runtime/second/candidate.xpi"
        run_checked(clean, "build.ps1", output, ("-OutputPath", str(first)))
        run_checked(clean, "build.ps1", output, ("-OutputPath", str(second)))
        packaged_files = verify_xpi(first, clean / "src")
        verify_xpi(second, clean / "src")
        if first.read_bytes() != second.read_bytes():
            raise ValueError("Double-build XPI hashes differ")
        package = output / f"zotero-sideline-{version}.xpi"
        shutil.copyfile(first, package)
        summary.update(verified=True, packagedFiles=packaged_files, packageSHA256=digest(package.read_bytes()),
                       byteEquality=True, doubleBuildIdentical=True, toolVersions=tools,
                       tests="Full fake-host suite passed; see local test.log")
    else:
        package = output / f"zotero-sideline-{version}.xpi"
        archive_files(package, clean / "src", sorted(entry for entry in (clean / "src").rglob("*") if entry.is_file()))
        verify_xpi(package, clean / "src")
    # runtime is deliberately absent from source ZIP, even after validation builds.
    source_zip = output / f"zotero-sideline-{version}-source.zip"
    exported = [clean / entry.relative_to(ROOT) for entry in selected]
    archive_files(source_zip, clean, exported)
    with zipfile.ZipFile(source_zip) as archive:
        if set(archive.namelist()) != {entry.relative_to(ROOT).as_posix() for entry in selected}:
            raise ValueError("Source archive manifest mismatch")
        if any(archive.read(entry.relative_to(ROOT).as_posix()) != entry.read_bytes() for entry in selected):
            raise ValueError("Source archive bytes mismatch")
    report = output / "validation.json"
    report.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    checksums = [f"{digest(entry.read_bytes())}  {entry.name}" for entry in (package, source_zip, report)]
    (output / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n", encoding="ascii")
    print(json.dumps({"directory": str(output), "validation": summary}, ensure_ascii=True))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL release preparation: {error}", file=sys.stderr)
        sys.exit(1)
