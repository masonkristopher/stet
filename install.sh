#!/usr/bin/env bash
# stet installer: downloads the prebuilt binary from GitHub Releases.
#   curl -fsSL https://raw.githubusercontent.com/jimmy-guzman/stet/main/install.sh | bash
# Options (pass after `bash -s --`):
#   --version <x.y.z>   install a specific version instead of the latest
set -euo pipefail

REPO="jimmy-guzman/stet"
APP="stet"

shell_config_file() {
  shell_name="${SHELL##*/}"
  case "$shell_name" in
    zsh) echo "$HOME/.zshrc" ;;
    bash)
      if [ "$(uname -s)" = "Darwin" ]; then
        echo "$HOME/.bash_profile"
      else
        echo "$HOME/.bashrc"
      fi
      ;;
    *) echo "$HOME/.profile" ;;
  esac
}

print_path_fallback() {
  echo
  echo "add $APP to your PATH:"
  echo "  export PATH=\"$install_dir:\$PATH\""
}

configure_path() {
  shell_config="$(shell_config_file)"

  if [ -f "$shell_config" ] && grep -Fqs "$install_dir" "$shell_config"; then
    echo
    echo "$install_dir is already configured in $shell_config"
    echo "restart your shell or run: source $shell_config"
    return
  fi

  if printf '\nexport PATH="%s:$PATH"\n' "$install_dir" >>"$shell_config" 2>/dev/null; then
    echo
    echo "added $install_dir to PATH in $shell_config"
    echo "restart your shell or run: source $shell_config"
  else
    print_path_fallback
  fi
}

requested_version=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "--version requires an argument, e.g. --version 0.1.0" >&2
        exit 1
      fi
      requested_version="$2"
      shift 2
      ;;
    *)
      echo "unknown option: $1" >&2
      exit 1
      ;;
  esac
done

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "unsupported OS: $(uname -s). Try: npm i -g stet" >&2
    exit 1
    ;;
esac

arch="$(uname -m)"
case "$arch" in
  aarch64 | arm64) arch="arm64" ;;
  x86_64) arch="x64" ;;
  *)
    echo "unsupported architecture: $arch. Try: npm i -g stet" >&2
    exit 1
    ;;
esac

# Rosetta reports x86_64; prefer the native arm64 build
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    arch="arm64"
  fi
fi

if [ "$os" = "linux" ]; then
  if [ -f /etc/alpine-release ] || (ldd --version 2>&1 || true) | grep -qi musl; then
    echo "musl libc is not supported by the prebuilt binaries yet. Try: npm i -g stet" >&2
    exit 1
  fi
fi

filename="$APP-$os-$arch.tar.gz"

if [ -n "$requested_version" ]; then
  url="https://github.com/$REPO/releases/download/v$requested_version/$filename"
  sums_url="https://github.com/$REPO/releases/download/v$requested_version/SHA256SUMS"
else
  url="https://github.com/$REPO/releases/latest/download/$filename"
  sums_url="https://github.com/$REPO/releases/latest/download/SHA256SUMS"
fi

install_dir="${STET_INSTALL_DIR:-${XDG_BIN_DIR:-$HOME/.stet/bin}}"
mkdir -p "$install_dir"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading $url"
curl -fsSL -o "$tmp/$filename" "$url"
curl -fsSL -o "$tmp/SHA256SUMS" "$sums_url"

expected="$(awk -v file="$filename" '$2 == file { print $1 }' "$tmp/SHA256SUMS")"
if [ -z "$expected" ]; then
  echo "no checksum for $filename in SHA256SUMS; aborting" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$filename" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$filename" | cut -d' ' -f1)"
fi

if [ "$expected" != "$actual" ]; then
  echo "checksum mismatch for $filename: expected $expected, got $actual" >&2
  exit 1
fi

tar -xzf "$tmp/$filename" -C "$tmp"

mv "$tmp/$APP" "$install_dir/$APP"
chmod 755 "$install_dir/$APP"

echo "installed $APP to $install_dir/$APP"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$install_dir" >>"$GITHUB_PATH"
else
  case ":$PATH:" in
    *":$install_dir:"*) ;;
    *) configure_path ;;
  esac
fi

"$install_dir/$APP" --version
