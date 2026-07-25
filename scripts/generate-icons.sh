#!/usr/bin/env bash
#
# Regenerate every app icon on every platform from the one brand source.
#
# WHY THIS EXISTS
# ---------------
# There was no icon tooling, so nothing ever regenerated the icon set. The
# desktop bundles shipped Tauri's stock placeholder (a plain red circle) from
# the v0.3.0 initial release for 3.5 months, and the Expo mobile icons were
# still the stock template art — while the brand assets were revised repeatedly
# and nobody noticed, because the icons are binaries that no test looks at.
#
# Run this whenever the brand art changes. Committing the output is the point:
# these files ARE the shipped icons.
#
#   bash scripts/generate-icons.sh
#
# Requires: python3 + Pillow, and npx (@tauri-apps/cli from devDependencies).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO/packages/web/public/Corkboards-favicon.png"
ICONS="$REPO/packages/desktop/src-tauri/icons"
MASTER="$ICONS/master-1024.png"
MOBILE="$REPO/packages/mobile/assets"

[[ -f "$SRC" ]] || { echo "missing brand source: $SRC" >&2; exit 1; }

echo "==> Building 1024x1024 master from $SRC"
# The brand source is a 128x128 palette PNG, so this is an ~8.5x upscale and the
# result is inherently soft. Replace $SRC with a high-resolution square export
# and this script immediately produces sharper icons with no other changes.
python3 - "$SRC" "$MASTER" <<'PY'
import sys
from PIL import Image, ImageFilter

src, out = sys.argv[1], sys.argv[2]
SIZE, FILL = 1024, 0.80   # 80% fill leaves padding so circular launcher masks
                          # (GNOME, Android round icons) don't clip pin or point

im = Image.open(src).convert('RGBA')
bbox = im.getchannel('A').getbbox()      # trim the uneven margins in the source
pin = im.crop(bbox)
w, h = pin.size

scale = (SIZE * FILL) / max(w, h)
nw, nh = round(w * scale), round(h * scale)
pin = pin.resize((nw, nh), Image.LANCZOS)
# Lanczos at this ratio blurs the silhouette; a light unsharp mask restores it
# without ringing at the sizes these icons are actually viewed at.
pin = pin.filter(ImageFilter.UnsharpMask(radius=3, percent=80, threshold=2))

canvas = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
canvas.paste(pin, ((SIZE - nw) // 2, (SIZE - nh) // 2), pin)
canvas.save(out, optimize=True)
print(f"    {w}x{h} -> {nw}x{nh} centred on {SIZE}x{SIZE} ({scale:.2f}x)")
PY

echo "==> Generating desktop icon set (Tauri)"
# Produces the PNGs in bundle.icon plus a REAL .icns container and a multi-size
# .ico. Both were previously broken: icon.icns was a renamed 128x128 PNG, and
# icon.ico held a single image with no small sizes.
( cd "$REPO/packages/desktop/src-tauri" && npx @tauri-apps/cli icon "$MASTER" -o "$ICONS" >/dev/null )

# Tauri also emits android/ and ios/ sets for Tauri-mobile. This repo's mobile
# app is Expo/React Native, so those would never be consumed — drop them rather
# than leave two competing sources of truth.
rm -rf "$ICONS/android" "$ICONS/ios"

echo "==> Generating Expo mobile icons"
python3 - "$MASTER" "$MOBILE" <<'PY'
import sys, os
from PIL import Image
master, mobile = sys.argv[1], sys.argv[2]
im = Image.open(master).convert('RGBA')

# Sizes per packages/mobile/app.json: icon, adaptive-icon.foregroundImage,
# splash.image. Expo expects 1024x1024 for all three.
for name in ('icon.png', 'adaptive-icon.png', 'splash-icon.png'):
    im.resize((1024, 1024), Image.LANCZOS).save(os.path.join(mobile, name), optimize=True)
    print(f"    {name} 1024x1024")
PY

echo "==> Generating PWA icons"
python3 - "$MASTER" "$REPO/packages/web/public" <<'PY'
import sys, os
from PIL import Image
master, pub = sys.argv[1], sys.argv[2]
im = Image.open(master).convert('RGBA')
for size in (192, 512):
    im.resize((size, size), Image.LANCZOS).save(
        os.path.join(pub, f'Corkboards-icon-{size}.png'), optimize=True)
    print(f"    Corkboards-icon-{size}.png")

# Maskable icons are cropped to a safe zone by the OS, so the art must sit
# within the inner ~80% or Android will clip it. Scale to 60% on an opaque
# background: transparent maskables render as black wedges on some launchers.
for size in (512,):
    canvas = Image.new('RGBA', (size, size), (245, 245, 245, 255))
    inner = round(size * 0.60)
    art = im.resize((inner, inner), Image.LANCZOS)
    canvas.paste(art, ((size - inner) // 2, (size - inner) // 2), art)
    canvas.save(os.path.join(pub, f'Corkboards-maskable-{size}.png'), optimize=True)
    print(f"    Corkboards-maskable-{size}.png")
PY

echo
echo "==> Done. Verify:"
echo "    file $ICONS/icon.icns   # must say 'Mac OS X icon', not 'PNG image data'"
echo "    file $ICONS/icon.ico    # must report more than 1 icon"
echo "    Then rebuild: cd packages/web && npm run build"
echo "                  cd ../desktop/src-tauri && npx @tauri-apps/cli build"
