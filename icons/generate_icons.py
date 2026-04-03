#!/usr/bin/env python3
"""
generate_icons.py — ClawTab icon generator

Design concept: White trident on blue→violet gradient
  - Three upward prongs (center taller) represent the three claws
  - Connecting bar + handle unify the shape into a single bold mark
  - Filled solid shapes — legible and bold at every size
  - Background: electric blue (#2563eb) → violet (#7c3aed) diagonal gradient

Usage: python3 icons/generate_icons.py
"""
import os
import cairosvg

OUT_DIR = os.path.dirname(os.path.abspath(__file__))


def make_svg_large() -> str:
    """
    128 × 128 viewBox trident for 128 px and 48 px output.

    Layout (SVG units):
      Three prongs centred at x = 36, 64, 92  (spacing = 28 px)
      Each prong 14 px wide, rounded caps (rx = 7)
      Centre prong taller (y = 14, h = 58) than outer (y = 26, h = 46)
      All prongs bottom-aligned at y = 72
      Horizontal bar  y = 68–78, spanning x = 29–99
      Handle          y = 74–110, x = 57–71 (14 px wide, rounded bottom)

      Overlapping white rects merge into one seamless mark — no path math.
    """
    return """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="128" y2="128">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>

  <!-- Gradient background -->
  <rect width="128" height="128" rx="26" fill="url(#bg)"/>

  <!-- Trident mark (white filled) -->
  <rect x="29" y="26" width="14" height="46" rx="7"  fill="white"/><!-- left prong  -->
  <rect x="57" y="14" width="14" height="58" rx="7"  fill="white"/><!-- centre prong -->
  <rect x="85" y="26" width="14" height="46" rx="7"  fill="white"/><!-- right prong  -->
  <rect x="29" y="68" width="70" height="10"          fill="white"/><!-- cross-bar    -->
  <rect x="57" y="74" width="14" height="36" rx="7"  fill="white"/><!-- handle       -->
</svg>"""


def make_svg_small() -> str:
    """
    16 × 16 viewBox trident for 16 px output.

    Proportions are expanded (every shape ≥ 2 px wide at 1:1) so the
    trident reads clearly at tiny size.  Uses the same gradient colours.
    """
    return """\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <defs>
    <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="16" y2="16">
      <stop offset="0%" stop-color="#2563eb"/>
      <stop offset="100%" stop-color="#7c3aed"/>
    </linearGradient>
  </defs>

  <rect width="16" height="16" rx="3.5" fill="url(#bg)"/>

  <!-- Trident: three prongs + bar + handle -->
  <rect x="2"    y="3.5" width="2.5" height="5"   rx="1.25" fill="white"/>
  <rect x="6.75" y="2"   width="2.5" height="6.5" rx="1.25" fill="white"/>
  <rect x="11.5" y="3.5" width="2.5" height="5"   rx="1.25" fill="white"/>
  <rect x="2"    y="7.5" width="12"  height="1.75"           fill="white"/>
  <rect x="6.75" y="8.5" width="2.5" height="5.5" rx="1.25" fill="white"/>
</svg>"""


def main() -> None:
    jobs = [
        (128, make_svg_large()),
        (48,  make_svg_large()),
        (16,  make_svg_small()),
    ]
    for size, svg in jobs:
        out_path = os.path.join(OUT_DIR, f"icon{size}.png")
        cairosvg.svg2png(
            bytestring=svg.encode(),
            write_to=out_path,
            output_width=size,
            output_height=size,
        )
        print(f"✓  icon{size}.png  ({size}×{size}px)")

    print("\nAll icons written to icons/")


if __name__ == "__main__":
    main()
