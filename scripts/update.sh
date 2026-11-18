#!/usr/bin/env bash
#
# Aktualisiert Instamatisierung auf die neueste Version von GitHub.
#
# Deine Einstellungen (.env) und Daten (Ordner data: Automationen, Aktivität,
# Instagram-Verbindung) bleiben dabei unverändert.
#
# Aufruf im Ordner des Tools, z. B. in der SSH-Konsole von Infomaniak:
#   cd ~/sites/quickresponse.fabulousteaching.ch && curl -fsSL https://raw.githubusercontent.com/fabulousteaching/Instamatisierung/claude/charming-archimedes-mdvv6l/scripts/update.sh | bash
#
# Danach das Tool neu starten (bei Infomaniak im Manager auf "Neu starten").

set -euo pipefail

REPO="fabulousteaching/Instamatisierung"
BRANCH="${INSTAMATISIERUNG_BRANCH:-claude/charming-archimedes-mdvv6l}"
APP_DIR="$(pwd)"

# Sicherheitsprüfung: Sind wir wirklich im Ordner des Tools?
if [ ! -f "$APP_DIR/package.json" ] || ! grep -q '"name": "instamatisierung"' "$APP_DIR/package.json"; then
  echo "✗ Hier liegt kein Instamatisierung-Tool ($APP_DIR)."
  echo "  Bitte zuerst in den Ordner des Tools wechseln (cd …) und erneut starten."
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Lade die neueste Version herunter …"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP" --strip-components=1

if [ ! -f "$TMP/package.json" ] || [ ! -d "$TMP/src" ]; then
  echo "✗ Download unvollständig – nichts wurde verändert."
  exit 1
fi

echo "→ Ersetze Programmdateien (.env und data bleiben unverändert) …"
for item in src public scripts package.json package-lock.json README.md ANLEITUNG.md .env.example Dockerfile; do
  if [ -e "$TMP/$item" ]; then
    rm -rf "${APP_DIR:?}/$item"
    cp -R "$TMP/$item" "$APP_DIR/$item"
  fi
done

echo "→ Installiere Abhängigkeiten …"
npm install --omit=dev --no-audit --no-fund --loglevel=error

echo ""
echo "✓ Fertig! Jetzt das Tool neu starten (Infomaniak-Manager → „Neu starten“)."
