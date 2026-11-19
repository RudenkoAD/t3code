#!/usr/bin/env python3
"""Оставить актуальный T3 Code (Local Fork) в /Applications. По умолчанию — просмотр."""
import argparse
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys
import tempfile
from xml.parsers.expat import ExpatError

APP = "T3 Code (Local Fork).app"
KEEP = Path("/Applications") / APP
RELEASES = Path(__file__).resolve().parents[1] / "release-fork"
SOURCE = RELEASES / "0.1.12/mac-arm64" / APP
BUNDLE_ID = "com.t3tools.t3code"
MIN_VERSION = (0, 1, 12)


def metadata(app):
    try:
        with (app / "Contents/Info.plist").open("rb") as source:
            info = plistlib.load(source)
    except (OSError, ValueError, ExpatError, plistlib.InvalidFileException):
        return {}
    return info if isinstance(info, dict) and info.get("CFBundleIdentifier") == BUNDLE_ID else {}


def fork_version(app):
    version = metadata(app).get("CFBundleShortVersionString", "")
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)-local-fork", version)
    return tuple(map(int, match.groups())) if match else ()


def duplicates():
    roots = [KEEP.parent, Path.home() / "Applications", Path.home() / "Downloads",
             Path.home() / "Desktop", RELEASES]
    apps = set()
    for root in roots:
        for folder, dirs, _ in os.walk(root):
            for name in dirs.copy():
                path = Path(folder) / name
                if name.startswith(".") or path.is_symlink():
                    dirs.remove(name)
                elif name.lower().endswith(".app"):
                    dirs.remove(name)
                    if path != KEEP and metadata(path):
                        apps.add(path)
    return sorted(apps)


def check_closed(app):
    name = metadata(app).get("CFBundleExecutable")
    if not name:
        return
    result = subprocess.run(["/usr/sbin/lsof", "-t", str(app / "Contents/MacOS" / name)],
                            stdout=subprocess.PIPE)
    if result.stdout.strip():
        sys.exit(f"Закрой T3 через ⌘Q и запусти скрипт снова. Открыта копия {app}")
    if result.returncode not in (0, 1):
        sys.exit(f"Не удалось проверить, закрыто ли приложение {app}")


def verify(app):
    subprocess.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app], check=True)


def run(apply):
    if sys.platform != "darwin":
        sys.exit("Этот скрипт предназначен для macOS.")
    if KEEP.is_symlink() or (KEEP.exists() and not metadata(KEEP)):
        sys.exit(f"Не удалось подтвердить, что {KEEP} — приложение T3.")
    apps = duplicates()
    upgrade = fork_version(KEEP) < MIN_VERSION
    if upgrade and (SOURCE.is_symlink() or fork_version(SOURCE) != MIN_VERSION):
        sys.exit(f"Сначала установи T3 0.1.12 или новее в {KEEP}.")
    version = max(MIN_VERSION, fork_version(KEEP))
    if any(fork_version(app) > version for app in apps):
        sys.exit("Найдена более новая сборка. Установи её в /Applications перед очисткой.")
    verify(SOURCE if upgrade else KEEP)
    print(f"Останется {KEEP} ({'.'.join(map(str, version))}-local-fork).")
    if upgrade:
        print(f"Сначала будет установлена проверенная копия из {SOURCE}.")
    for app in apps:
        print(f"В Корзину: {app}")
    if not apply:
        print("Это предварительный просмотр. Для выполнения добавь --apply.")
        return
    for app in [*apps, *([KEEP] if upgrade and KEEP.exists() else [])]:
        check_closed(app)
    if upgrade:
        # Prepare the replacement on the same volume before moving the installed copy.
        with tempfile.TemporaryDirectory(prefix=".t3-install-", dir=KEEP.parent) as tmp:
            staged = Path(tmp) / APP
            subprocess.run(["/usr/bin/ditto", SOURCE, staged], check=True)
            verify(staged)
            if fork_version(staged) != MIN_VERSION:
                sys.exit("Версия скопированного приложения не совпала.")
            if KEEP.exists():
                subprocess.run(["/usr/bin/trash", KEEP], check=True)
            staged.rename(KEEP)
    verify(KEEP)
    for app in apps:
        if metadata(app) and app != KEEP and not app.is_symlink():
            subprocess.run(["/usr/bin/trash", app], check=True)
    print(f"Готово. Запускай {KEEP}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="установить и убрать дубликаты")
    try:
        run(parser.parse_args().apply)
    except (OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"Остановлено: {error}")
