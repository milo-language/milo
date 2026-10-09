#!/bin/sh
# Milo installer. Downloads a prebuilt compiler and puts it on your PATH.
#
#   curl -fsSL https://milo-language.github.io/milo/install.sh | sh
#
# Env overrides:
#   MILO_INSTALL_DIR   where the binary lands (default: $HOME/.local/bin)
#   MILO_TAG           release tag to pull (default: the newest vX.Y.Z release;
#                      MILO_TAG=latest for the rolling build of main)
#
# Deliberately POSIX sh, not bash: it runs under dash on Debian/Ubuntu images.

set -eu

REPO="milo-language/milo"
TAG="${MILO_TAG:-}"
INSTALL_DIR="${MILO_INSTALL_DIR:-$HOME/.local/bin}"

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }

detect_target() {
    os=$(uname -s)
    arch=$(uname -m)
    case "$os" in
        Darwin) os=darwin ;;
        Linux)  os=linux ;;
        *) die "unsupported OS: $os. Milo ships binaries for macOS and Linux; build from source at https://milo-language.github.io/milo/getting-started/installation" ;;
    esac
    case "$arch" in
        arm64|aarch64) arch=arm64 ;;
        x86_64|amd64)  arch=x64 ;;
        *) die "unsupported architecture: $arch" ;;
    esac
    printf '%s-%s' "$os" "$arch"
}

fetch() {
    # $1 = url, $2 = output path
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --proto '=https' --tlsv1.2 "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -q --https-only "$1" -O "$2"
    else
        die "need curl or wget to download"
    fi
}

check_clang() {
    # Milo emits LLVM IR and shells out to clang to assemble and link. Without it
    # the compiler installs fine and then fails on the first build, which reads as
    # a broken install — so say it up front rather than at first use.
    if command -v clang >/dev/null 2>&1 || command -v cc >/dev/null 2>&1; then
        return 0
    fi
    printf '\n\033[33mwarning:\033[0m no clang found. Milo needs it to link binaries.\n'
    case "$(uname -s)" in
        Darwin) printf '  Install with: xcode-select --install\n\n' ;;
        Linux)  printf '  Install with: sudo apt install clang   (or your distro'\''s equivalent)\n\n' ;;
    esac
}

# The newest v* tag, read from the release list rather than GitHub's "latest release"
# pointer: that pointer follows whichever release was published last unless told
# otherwise, and the rolling `latest` build is republished on every push to main.
newest_version_tag() {
    fetch "https://api.github.com/repos/$REPO/releases?per_page=30" "$1" \
        || die "could not list releases (set MILO_TAG=vX.Y.Z to skip the lookup)"
    sed -n 's/.*"tag_name": *"\(v[0-9][^"]*\)".*/\1/p' "$1" | head -n 1
}

main() {
    target=$(detect_target)

    tmp=$(mktemp -d)
    # The trap must survive the early exits in die(); mktemp dirs in /tmp are not
    # cleaned by every system.
    trap 'rm -rf "$tmp"' EXIT INT TERM

    if [ -z "$TAG" ]; then
        TAG=$(newest_version_tag "$tmp/releases.json")
        [ -n "$TAG" ] || die "no versioned release found (MILO_TAG=latest installs the rolling build)"
    fi
    url="https://github.com/$REPO/releases/download/$TAG/milo-$target.tar.gz"

    info "installing milo $TAG ($target)"
    fetch "$url" "$tmp/milo.tar.gz" || die "download failed: $url"
    tar xzf "$tmp/milo.tar.gz" -C "$tmp" || die "could not extract archive"

    # Archives built before 2026-07-30 are flat (a bare `milo` at the root); newer
    # ones wrap the binary in milo-<target>/. Accept either so an older tag still
    # installs.
    if [ -f "$tmp/milo-$target/milo" ]; then
        bin="$tmp/milo-$target/milo"
    elif [ -f "$tmp/milo" ]; then
        bin="$tmp/milo"
    else
        die "archive did not contain a milo binary"
    fi

    mkdir -p "$INSTALL_DIR"
    chmod +x "$bin"
    # mv across filesystems can fail (tmp is often its own mount), so fall back to cp.
    mv "$bin" "$INSTALL_DIR/milo" 2>/dev/null || {
        cp "$bin" "$INSTALL_DIR/milo" && chmod +x "$INSTALL_DIR/milo"
    }

    installed=$("$INSTALL_DIR/milo" --version 2>/dev/null || echo "unknown version")
    info "installed $installed to $INSTALL_DIR/milo"

    check_clang

    case ":$PATH:" in
        *":$INSTALL_DIR:"*)
            printf 'Run \033[1mmilo --help\033[0m to get started.\n'
            ;;
        *)
            printf '\033[33m%s is not on your PATH.\033[0m Add it:\n\n' "$INSTALL_DIR"
            printf '  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zshrc && exec zsh\n\n' "$INSTALL_DIR"
            printf 'Then run \033[1mmilo --help\033[0m.\n'
            ;;
    esac
}

main
