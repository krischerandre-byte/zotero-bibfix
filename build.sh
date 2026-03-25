#!/bin/bash
# BibFix – Build XPI for Zotero 8
# Usage: ./build.sh

set -e

PLUGIN_NAME="bibfix"
VERSION=$(grep '"version"' manifest.json | head -1 | sed 's/.*: *"\(.*\)".*/\1/')
OUTPUT="${PLUGIN_NAME}-${VERSION}.xpi"

echo "Building ${OUTPUT}..."

# Remove old build
rm -f "$OUTPUT"

# Create XPI (ZIP archive)
zip -r "$OUTPUT" \
    manifest.json \
    bootstrap.js \
    prefs.js \
    prefs.xhtml \
    chrome/ \
    -x "*.DS_Store" \
    -x "__MACOSX/*"

echo ""
echo "✓ Built: ${OUTPUT}"
echo ""
echo "Installation in Zotero 8:"
echo "  1. Öffne Zotero 8"
echo "  2. Gehe zu Werkzeuge → Add-ons (oder Extras → Add-ons)"
echo "  3. Klicke auf das Zahnrad-Symbol → 'Install Add-on From File...'"
echo "  4. Wähle die Datei: ${OUTPUT}"
echo "  5. Starte Zotero neu"
echo ""
echo "Nach der Installation:"
echo "  - Rechtsklick auf ein Item → 'BibFix: Eintrag optimieren'"
echo "  - Rechtsklick auf ein Item → 'BibFix: Kurztitel generieren'"
echo "  - Einstellungen: Zotero → Einstellungen → BibFix (API Key etc.)"
