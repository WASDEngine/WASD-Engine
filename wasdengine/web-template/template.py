#!/usr/bin/env python3
"""Package and verify WASD Engine's Godot Web export template.

build.sh runs the godot-version and package commands; the release workflow
(.github/workflows/wasd-web-template.yml) runs verify and pin. BUILD.md
describes the files. The script needs only the standard library of Python 3.8
or newer. Every failure prints one "template.py: error:" line on stderr and
exits with status 1.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import zipfile
from typing import Any, Dict, List, Optional

TEMPLATE_FILE = "web_nothreads_release.zip"
# The entry the Godot plugin reads from the archive (webTemplateEntry), as in Godot's own export templates.
TEMPLATE_ENTRY = "templates/" + TEMPLATE_FILE
VERSION_ENTRY = "templates/version.txt"
MANIFEST_FILE = "manifest.json"
FORMAT = 1
# The files of a single-threaded Web release template that SCons writes (platform/web/emscripten_helpers.py).
TEMPLATE_MEMBERS = (
    "godot.audio.position.worklet.js",
    "godot.audio.worklet.js",
    "godot.html",
    "godot.js",
    "godot.offline.html",
    "godot.service.worker.js",
    "godot.wasm",
)
# Every entry gets this time, the earliest a ZIP file can store, so equal files give equal archives.
ZIP_TIME = (1980, 1, 1, 0, 0, 0)
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*\Z")
GODOT_PATTERN = re.compile(r"^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[A-Za-z0-9_.-]+)?\Z")
EMSCRIPTEN_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+\Z")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}\Z")
# The plugin default that the pin command reads: webTemplateSha256 in packages/gamedev/godot/src/index.ts.
PIN_PATTERN = re.compile(r"webTemplateSha256: z\.string\(\)[^\n]*\.default\('([0-9a-f]{64})'\)")
COPY_CHUNK_BYTES = 1 << 20

Record = Dict[str, Any]


class TemplateToolError(Exception):
    """A failure reported as one error line and exit status 1."""


def check_pattern(value: str, pattern: "re.Pattern[str]", what: str) -> None:
    """Reject a value that does not match its pattern.

    @param value: the value to check.
    @param pattern: the pattern it must match.
    @param what: the value's name for the error message.
    @raises TemplateToolError: when the value does not match.
    """
    if pattern.match(value) is None or ".." in value:
        raise TemplateToolError(f"invalid {what} {value!r}")


def archive_name(version: str) -> str:
    """Name the export templates archive of a template version.

    @param version: template version such as 4.7.2-wasd.1.
    @returns: web-template-<version>.tpz.
    """
    return f"web-template-{version}.tpz"


def release_url(repository: str, version: str, file_name: str) -> str:
    """URL of a file in the GitHub release web-template-<version>.

    @param repository: owner/name of the repository that hosts the release.
    @param version: template version.
    @param file_name: release asset name.
    @returns: the asset's download URL.
    """
    return f"https://github.com/{repository}/releases/download/web-template-{version}/{file_name}"


def sha256_file(path: str) -> str:
    """SHA-256 digest of a file.

    @param path: file to read.
    @returns: the digest as 64 lowercase hexadecimal digits.
    """
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for chunk in iter(lambda: stream.read(COPY_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def godot_version(source: str) -> str:
    """Read the Godot version of a source tree from its version.py without running it.

    @param source: Godot source directory.
    @returns: <major>.<minor>[.<patch>]-<status>, the form of Godot's release tags, such as 4.7.2-stable.
    @raises TemplateToolError: when version.py is missing or lacks a field.
    """
    path = os.path.join(source, "version.py")
    try:
        with open(path, encoding="utf-8") as stream:
            text = stream.read()
    except OSError as error:
        raise TemplateToolError(f"cannot read {path}: {error.strerror}; the source is not a Godot checkout") from error
    numbers = {}
    for field in ("major", "minor", "patch"):
        match = re.search(rf"^{field} = (\d+)\s*$", text, re.MULTILINE)
        if match is None:
            raise TemplateToolError(f"{path} has no integer {field} field")
        numbers[field] = match.group(1)
    status = re.search(r'^status = "([A-Za-z0-9_.-]*)"\s*$', text, re.MULTILINE)
    if status is None:
        raise TemplateToolError(f"{path} has no status field")
    number = f"{numbers['major']}.{numbers['minor']}"
    if numbers["patch"] != "0":
        number += f".{numbers['patch']}"
    return f"{number}-{status.group(1)}" if status.group(1) else number


def zip_entry(name: str, compress: int) -> zipfile.ZipInfo:
    """A ZIP entry with fixed metadata: ZIP_TIME, a regular file readable by all, made on Unix.

    @param name: entry name.
    @param compress: zipfile.ZIP_STORED or zipfile.ZIP_DEFLATED.
    @returns: the entry header.
    """
    info = zipfile.ZipInfo(name, ZIP_TIME)
    info.compress_type = compress
    info.create_system = 3
    info.external_attr = 0o100644 << 16
    return info


def write_template(source_zip: str, destination: str) -> None:
    """Rewrite the template ZIP that SCons made into one whose bytes depend only on the files it holds.

    SCons stores each file with its modification time. This copy stores the files uncompressed, in name order,
    with ZIP_TIME and fixed attributes, so builds of the same sources give the same SHA-256; the export templates
    archive compresses it for the download.

    @param source_zip: bin/godot.web.template_release.wasm32.nothreads.zip of a Godot build.
    @param destination: path of the template to write.
    @raises TemplateToolError: when the ZIP does not hold exactly the files of a Web release template.
    """
    try:
        with zipfile.ZipFile(source_zip) as source:
            names = sorted(info.filename for info in source.infolist() if not info.is_dir())
            if tuple(names) != TEMPLATE_MEMBERS:
                raise TemplateToolError(
                    f"{source_zip} holds {', '.join(names) or 'no files'}; a single-threaded Web release template "
                    f"holds {', '.join(TEMPLATE_MEMBERS)}"
                )
            with zipfile.ZipFile(destination, "w") as target:
                for name in names:
                    target.writestr(zip_entry(name, zipfile.ZIP_STORED), source.read(name))
    except (OSError, zipfile.BadZipFile) as error:
        raise TemplateToolError(f"cannot read {source_zip}: {error}") from error


def write_archive(template: str, destination: str, godot: str) -> None:
    """Write the export templates archive: TEMPLATE_ENTRY and VERSION_ENTRY, as in Godot's own .tpz files.

    @param template: the template ZIP to hold.
    @param destination: path of the archive to write.
    @param godot: Godot version such as 4.7.2-stable; version.txt holds Godot's form of it, such as 4.7.2.stable.
    """
    with zipfile.ZipFile(destination, "w") as archive:
        archive.writestr(zip_entry(VERSION_ENTRY, zipfile.ZIP_DEFLATED), godot.replace("-", ".", 1))
        info = zip_entry(TEMPLATE_ENTRY, zipfile.ZIP_DEFLATED)
        with open(template, "rb") as stream, archive.open(info, "w") as sink:
            for chunk in iter(lambda: stream.read(COPY_CHUNK_BYTES), b""):
                sink.write(chunk)


def write_json_atomic(path: str, value: Record) -> None:
    """Write a JSON file through a temporary file in the same directory.

    @param path: destination.
    @param value: object to write, as indented JSON with a trailing newline.
    """
    directory = os.path.dirname(os.path.abspath(path))
    handle, temporary = tempfile.mkstemp(dir=directory, prefix=".manifest-")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(json.dumps(value, indent=2) + "\n")
        # mkstemp creates the file readable by its owner only; manifest.json is published like the archive.
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.remove(temporary)
        raise


def package(source_zip: str, out: str, version: str, godot: str, emscripten: str, repository: str) -> Record:
    """Write the template, the export templates archive, and manifest.json into a directory.

    @param source_zip: the template ZIP of a Godot build.
    @param out: output directory.
    @param version: template version.
    @param godot: Godot version of the build.
    @param emscripten: Emscripten version of the build.
    @param repository: owner/name of the repository whose release web-template-<version> hosts the archive.
    @returns: the manifest.
    """
    check_pattern(version, VERSION_PATTERN, "template version")
    check_pattern(godot, GODOT_PATTERN, "Godot version")
    check_pattern(emscripten, EMSCRIPTEN_PATTERN, "Emscripten version")
    check_pattern(repository, REPOSITORY_PATTERN, "repository")
    os.makedirs(out, exist_ok=True)
    template = os.path.join(out, TEMPLATE_FILE)
    archive = os.path.join(out, archive_name(version))
    write_template(source_zip, template)
    write_archive(template, archive, godot)
    manifest = {
        "format": FORMAT,
        "version": version,
        "godot": godot,
        "emscripten": emscripten,
        "template": {"entry": TEMPLATE_ENTRY, "bytes": os.path.getsize(template), "sha256": sha256_file(template)},
        "archive": {
            "url": release_url(repository, version, archive_name(version)),
            "bytes": os.path.getsize(archive),
            "sha256": sha256_file(archive),
        },
    }
    write_json_atomic(os.path.join(out, MANIFEST_FILE), manifest)
    return manifest


def read_manifest(path: str) -> Record:
    """Read and check manifest.json.

    @param path: the file.
    @returns: the manifest.
    @raises TemplateToolError: when the file is missing, not JSON, or lacks a field.
    """
    try:
        with open(path, encoding="utf-8") as stream:
            manifest = json.load(stream)
    except (OSError, ValueError) as error:
        raise TemplateToolError(f"cannot read {path}: {error}") from error
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise TemplateToolError(f"{path}: format must be {FORMAT}")
    for field, pattern in (("version", VERSION_PATTERN), ("godot", GODOT_PATTERN), ("emscripten", EMSCRIPTEN_PATTERN)):
        if not isinstance(manifest.get(field), str):
            raise TemplateToolError(f"{path}: {field} must be a string")
        check_pattern(manifest[field], pattern, f"{field} in {path}")
    for part in ("template", "archive"):
        record = manifest.get(part)
        if not isinstance(record, dict) or not isinstance(record.get("bytes"), int) or isinstance(record.get("bytes"), bool):
            raise TemplateToolError(f"{path}: {part} must hold bytes and sha256")
        if not isinstance(record.get("sha256"), str) or SHA256_PATTERN.match(record["sha256"]) is None:
            raise TemplateToolError(f"{path}: {part}.sha256 must be 64 lowercase hexadecimal digits")
    if manifest["template"].get("entry") != TEMPLATE_ENTRY:
        raise TemplateToolError(f"{path}: template.entry must be {TEMPLATE_ENTRY}")
    return manifest


def check_file(path: str, size: int, digest: str, what: str) -> None:
    """Require a file of the given size and SHA-256.

    @param path: the file.
    @param size: expected size in bytes.
    @param digest: expected SHA-256.
    @param what: the file's description for error messages.
    @raises TemplateToolError: when the file is missing or differs.
    """
    if not os.path.isfile(path):
        raise TemplateToolError(f"{what} {path} is missing")
    if os.path.getsize(path) != size or sha256_file(path) != digest:
        raise TemplateToolError(f"{what} {path} does not match manifest.json")


def verify(manifest_path: str, directory: str, version: str, base_url: str) -> Record:
    """Check a release directory against its manifest.json.

    The archive must have the manifest's URL, size, and digest; its template entry and the template file beside it
    must have the template's size and digest, and the template must hold exactly TEMPLATE_MEMBERS.

    @param manifest_path: manifest.json.
    @param directory: directory holding the archive and the template.
    @param version: the template version the release publishes.
    @param base_url: the release's download URL prefix, ending in a slash.
    @returns: the manifest.
    @raises TemplateToolError: on any mismatch.
    """
    manifest = read_manifest(manifest_path)
    if manifest["version"] != version:
        raise TemplateToolError(f"manifest.json describes version {manifest['version']}, not {version}")
    archive_file = archive_name(version)
    if manifest["archive"].get("url") != base_url + archive_file:
        raise TemplateToolError(f"manifest.json gives the archive URL {manifest['archive'].get('url')!r}, not {base_url + archive_file!r}")
    archive = os.path.join(directory, archive_file)
    check_file(archive, manifest["archive"]["bytes"], manifest["archive"]["sha256"], "the archive")
    template = manifest["template"]
    check_file(os.path.join(directory, TEMPLATE_FILE), template["bytes"], template["sha256"], "the template")
    with zipfile.ZipFile(archive) as stream:
        if sorted(stream.namelist()) != sorted((TEMPLATE_ENTRY, VERSION_ENTRY)):
            raise TemplateToolError(f"{archive} must hold exactly {TEMPLATE_ENTRY} and {VERSION_ENTRY}")
        if stream.read(VERSION_ENTRY).decode("utf-8") != manifest["godot"].replace("-", ".", 1):
            raise TemplateToolError(f"{VERSION_ENTRY} in {archive} does not name Godot {manifest['godot']}")
        digest = hashlib.sha256()
        size = 0
        with stream.open(TEMPLATE_ENTRY) as entry:
            for chunk in iter(lambda: entry.read(COPY_CHUNK_BYTES), b""):
                digest.update(chunk)
                size += len(chunk)
        if size != template["bytes"] or digest.hexdigest() != template["sha256"]:
            raise TemplateToolError(f"{TEMPLATE_ENTRY} in {archive} does not match manifest.json")
    with zipfile.ZipFile(os.path.join(directory, TEMPLATE_FILE)) as stream:
        if tuple(sorted(stream.namelist())) != TEMPLATE_MEMBERS:
            raise TemplateToolError(f"{TEMPLATE_FILE} must hold exactly {', '.join(TEMPLATE_MEMBERS)}")
    return manifest


def pin(manifest_path: str, plugin_source: str) -> str:
    """Require that the Godot plugin pins the template that a manifest describes.

    @param manifest_path: manifest.json of a build.
    @param plugin_source: packages/gamedev/godot/src/index.ts, whose webTemplateSha256 default names the template.
    @returns: the pinned digest.
    @raises TemplateToolError: when the source has no webTemplateSha256 default or it names another template.
    """
    manifest = read_manifest(manifest_path)
    try:
        with open(plugin_source, encoding="utf-8") as stream:
            match = PIN_PATTERN.search(stream.read())
    except OSError as error:
        raise TemplateToolError(f"cannot read {plugin_source}: {error.strerror}") from error
    if match is None:
        raise TemplateToolError(f"{plugin_source} has no webTemplateSha256 default")
    if match.group(1) != manifest["template"]["sha256"]:
        raise TemplateToolError(
            f"the Godot plugin pins the Web template {match.group(1)}, but this build is {manifest['template']['sha256']}; "
            "publish only the template the plugin pins (BUILD.md, Release)"
        )
    return match.group(1)


def main(argv: Optional[List[str]] = None) -> int:
    """Run one command.

    @param argv: arguments without the program name; sys.argv[1:] when None.
    @returns: the exit status.
    """
    parser = argparse.ArgumentParser(prog="template.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    version_command = commands.add_parser("godot-version", help="print the Godot version of a source tree")
    version_command.add_argument("--source", required=True)
    package_command = commands.add_parser("package", help="write the template, the archive, and manifest.json")
    package_command.add_argument("--zip", required=True)
    package_command.add_argument("--out", required=True)
    package_command.add_argument("--version", required=True)
    package_command.add_argument("--godot", required=True)
    package_command.add_argument("--emscripten", required=True)
    package_command.add_argument("--repository", required=True)
    verify_command = commands.add_parser("verify", help="check a release directory against manifest.json")
    verify_command.add_argument("--manifest", required=True)
    verify_command.add_argument("--dir", required=True)
    verify_command.add_argument("--version", required=True)
    verify_command.add_argument("--base-url", required=True)
    pin_command = commands.add_parser("pin", help="require that the Godot plugin pins the built template")
    pin_command.add_argument("--manifest", required=True)
    pin_command.add_argument("--plugin-source", required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == "godot-version":
            print(godot_version(args.source))
        elif args.command == "package":
            manifest = package(args.zip, args.out, args.version, args.godot, args.emscripten, args.repository)
            print(os.path.join(args.out, archive_name(args.version)))
            print(f"template SHA-256 {manifest['template']['sha256']}", file=sys.stderr)
        elif args.command == "verify":
            verify(args.manifest, args.dir, args.version, args.base_url)
        else:
            print(pin(args.manifest, args.plugin_source))
    except TemplateToolError as error:
        print(f"template.py: error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
