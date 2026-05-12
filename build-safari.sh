#!/bin/sh
set -eu

usage() {
    cat <<'EOF'
Usage: ./build-safari.sh [--version VERSION] [--app-name NAME] [--bundle-identifier ID] [--project-location PATH]

Builds a Safari-ready WebExtension bundle in ./builds/yomitan-safari-web-extension and
generates a macOS Safari app-extension Xcode project with `xcrun safari-web-extension-converter`.
EOF
}

ROOT_DIR=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
VERSION=0.0.0.0
APP_NAME="Yomitan Safari"
BUNDLE_IDENTIFIER="ryu67.yomitan.safari"
PROJECT_LOCATION="$ROOT_DIR/builds/yomitan-safari-app"
WEB_EXTENSION_DIR="$ROOT_DIR/builds/yomitan-safari-web-extension"

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version)
            VERSION="$2"
            shift 2
            ;;
        --app-name)
            APP_NAME="$2"
            shift 2
            ;;
        --bundle-id|--bundle-identifier)
            BUNDLE_IDENTIFIER="$2"
            shift 2
            ;;
        --project-location)
            PROJECT_LOCATION="$2"
            shift 2
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown argument: %s\n\n' "$1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

python3 - "$ROOT_DIR" "$WEB_EXTENSION_DIR" "$VERSION" <<'PY'
import copy
import json
import shutil
import sys
from pathlib import Path


def get_object_parent(root, path):
    current = root
    for item in path[:-1]:
        current = current[item]
    return current, path[-1]


def apply_modification(manifest, modification):
    action = modification["action"]
    path = modification["path"]

    if action == "set":
        parent, key = get_object_parent(manifest, path)
        parent[key] = copy.deepcopy(modification["value"])
    elif action == "replace":
        parent, key = get_object_parent(manifest, path)
        parent[key] = str(parent[key]).replace(modification["pattern"], modification["replacement"])
    elif action == "delete":
        parent, key = get_object_parent(manifest, path)
        if isinstance(parent, list):
            del parent[key]
        else:
            parent.pop(key, None)
    elif action == "remove":
        current = manifest
        for item in path:
            current = current[item]
        try:
            current.remove(modification["item"])
        except ValueError:
            pass
    elif action == "add":
        current = manifest
        for item in path:
            current = current[item]
        current.extend(copy.deepcopy(modification["items"]))
    elif action == "splice":
        current = manifest
        for item in path:
            current = current[item]
        start = modification["start"]
        delete_count = modification["deleteCount"]
        items = copy.deepcopy(modification["items"])
        current[start:start + delete_count] = items
    elif action in {"copy", "move"}:
        source_parent, source_key = get_object_parent(manifest, path)
        target_parent, target_key = get_object_parent(manifest, modification["newPath"])
        target_parent[target_key] = copy.deepcopy(source_parent[source_key])
        if action == "move":
            if isinstance(source_parent, list):
                del source_parent[source_key]
            else:
                source_parent.pop(source_key, None)
    else:
        raise RuntimeError(f"Unsupported manifest modification action: {action}")


root_dir = Path(sys.argv[1])
output_dir = Path(sys.argv[2])
version = sys.argv[3]

config = json.loads((root_dir / "dev/data/manifest-variants.json").read_text(encoding="utf-8"))
variant_map = {variant["name"]: variant for variant in config["variants"]}

variant = variant_map["safari"]
chain = []
seen = set()
while True:
    name = variant["name"]
    if name in seen:
        break
    seen.add(name)
    chain.insert(0, variant)
    inherit = variant.get("inherit")
    if not isinstance(inherit, str):
        break
    variant = variant_map[inherit]

manifest = copy.deepcopy(config["manifest"])
exclude_files = []
for variant in chain:
    for modification in variant.get("modifications", []):
        apply_modification(manifest, modification)
    for excluded in variant.get("excludeFiles", []):
        if excluded not in exclude_files:
            exclude_files.append(excluded)

if output_dir.exists():
    shutil.rmtree(output_dir)
shutil.copytree(root_dir / "ext", output_dir)

for relative_path in exclude_files:
    target = output_dir / relative_path
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()

manifest_text = json.dumps(manifest, indent=4) + "\n"
manifest_text = manifest_text.replace("$YOMITAN_VERSION", version)
(output_dir / "manifest.json").write_text(manifest_text, encoding="utf-8")
PY

xcrun safari-web-extension-converter \
    "$WEB_EXTENSION_DIR" \
    --project-location "$PROJECT_LOCATION" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$BUNDLE_IDENTIFIER" \
    --swift \
    --copy-resources \
    --no-open \
    --no-prompt \
    --force
    
MARKETING_VERSION="$VERSION"
BUILD_NUMBER=$(git -C "$ROOT_DIR" rev-list --count HEAD 2>/dev/null || printf '1')

python3 - "$PROJECT_LOCATION" "$APP_NAME" "$BUNDLE_IDENTIFIER" "$VERSION" "$BUILD_NUMBER" "$ROOT_DIR" <<'PY'
import plistlib
import re
import sys
from pathlib import Path

project_location = Path(sys.argv[1])
app_name = sys.argv[2]
bundle_identifier = sys.argv[3]
version = sys.argv[4]
build_number = sys.argv[5]
root_dir = Path(sys.argv[6])

extension_bundle_identifier = f"{bundle_identifier}.extension"
project_root = project_location / app_name
pbxproj_path = project_root / f"{app_name}.xcodeproj" / "project.pbxproj"

shared_extension_root = project_root / "Shared (Extension)"
handler_path = shared_extension_root / "SafariWebExtensionHandler.swift"

info_plist_paths = list(project_root.glob("*/Info.plist"))

pbxproj = pbxproj_path.read_text(encoding="utf-8")


def replace_bundle_identifier(match):
    line = match.group(0)
    value = line.split("=", 1)[1].rsplit(";", 1)[0].strip().strip('"')
    replacement = extension_bundle_identifier if value.endswith(".Extension") else bundle_identifier
    quoted = f'"{replacement}"' if '"' in line else replacement
    return f"PRODUCT_BUNDLE_IDENTIFIER = {quoted};"


pbxproj = re.sub(r"PRODUCT_BUNDLE_IDENTIFIER = [^;]+;", replace_bundle_identifier, pbxproj)
pbxproj = re.sub(
    r"(ENABLE_HARDENED_RUNTIME = YES;\n)(\s+)(ENABLE_USER_SELECTED_FILES = readonly;)",
    r"\1\2ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;\n\2\3",
    pbxproj,
    count=2,
)
pbxproj = re.sub(
    r"VERSIONING_SYSTEM = [^;]+;",
    "VERSIONING_SYSTEM = apple-generic;",
    pbxproj,
)
pbxproj_path.write_text(pbxproj, encoding="utf-8")

for view_controller_path in project_root.glob("*/ViewController.swift"):
    view_controller = view_controller_path.read_text(encoding="utf-8")
    view_controller = re.sub(
        r'let extensionBundleIdentifier = ".*"',
        f'let extensionBundleIdentifier = "{extension_bundle_identifier}"',
        view_controller,
    )
    view_controller_path.write_text(view_controller, encoding="utf-8")

handler_source_path = root_dir / "dev" / "safari" / "SafariWebExtensionHandler.swift"
handler_path.parent.mkdir(parents=True, exist_ok=True)
handler_path.write_text(handler_source_path.read_text(encoding="utf-8"), encoding="utf-8")

for info_plist_path in info_plist_paths:
    with info_plist_path.open("rb") as file:
        info_plist = plistlib.load(file)
    app_transport_security = info_plist.setdefault("NSAppTransportSecurity", {})
    app_transport_security["NSAllowsLocalNetworking"] = True
    with info_plist_path.open("wb") as file:
        plistlib.dump(info_plist, file)
PY

printf 'Safari WebExtension bundle: %s\n' "$WEB_EXTENSION_DIR"
printf 'Safari Xcode project: %s\n' "$PROJECT_LOCATION/$APP_NAME/$APP_NAME.xcodeproj"
