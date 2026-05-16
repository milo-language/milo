#!/bin/sh
set -e

REPO="cs01/milo"
INSTALL_DIR="${MILO_INSTALL_DIR:-/usr/local/bin}"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) OS="darwin" ;;
  linux)  OS="linux" ;;
  *) echo "error: unsupported OS: $OS" >&2; exit 1 ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64)  ARCH="x64" ;;
  *) echo "error: unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

TARGET="${OS}-${ARCH}"
URL="https://github.com/${REPO}/releases/latest/download/milo-${TARGET}.tar.gz"

echo "downloading milo (${TARGET})..."
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

curl -fsSL "$URL" -o "$TMPDIR/milo.tar.gz"
tar xzf "$TMPDIR/milo.tar.gz" -C "$TMPDIR"
install -m 755 "$TMPDIR/milo" "$INSTALL_DIR/milo"

echo "installed milo to ${INSTALL_DIR}/milo"
milo --version 2>/dev/null || true
