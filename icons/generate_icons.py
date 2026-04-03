#!/usr/bin/env python3
"""
generate_icons.py — ClawTab icon generator
Design: Three curved claw marks on a dark-to-teal gradient background.
Usage: python3 icons/generate_icons.py
"""
import os
import cairosvg

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# (output_size_px, stroke_width_in_svg_units)
# SVG viewBox is 128x128; stroke scales with output size.
# Outer claws get heavier strokes at smaller sizes for legibility.
SIZES = [
    (128, 11),
    (48,  14),
    (16,  21),
]


def make_svg(stroke_width: int) -> str:
    """
    SVG viewBox: 0 0 128 128
    Layout:
      - Rounded-rect background with linear gradient (dark navy → teal)
      - Subtle cyan glow circle at claw origin
      - Three bezier claw strokes spreading upward
      - Small white anchor dot at origin
    """
    return f"""\
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0f172a"/>
      <stop offset="100%" stop-color="#0891b2"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="128" height="128" rx="26" ry="26" fill="url(#bg)"/>

  <!-- Subtle glow at claw origin -->
  <circle cx="64" cy="86" r="18" fill="#22d3ee" opacity="0.18"/>

  <!-- Three claw marks (white, curved bezier paths) -->
  <!-- Origin: (64, 86). Left claw → (32, 26). Center → (64, 24). Right → (96, 26). -->
  <g stroke="white" stroke-width="{stroke_width}" stroke-linecap="round" fill="none">
    <path d="M 64,86 Q 48,58 32,26"/>
    <path d="M 64,86 Q 64,58 64,24"/>
    <path d="M 64,86 Q 80,58 96,26"/>
  </g>

  <!-- Anchor dot at origin -->
  <circle cx="64" cy="86" r="6.5" fill="white"/>
</svg>"""


def main() -> None:
    for size, sw in SIZES:
        svg_bytes = make_svg(sw).encode()
        out_path = os.path.join(OUT_DIR, f"icon{size}.png")
        cairosvg.svg2png(
            bytestring=svg_bytes,
            write_to=out_path,
            output_width=size,
            output_height=size,
        )
        print(f"✓  icon{size}.png  ({size}×{size}px, stroke={sw})")

    print("\nAll icons written to icons/")


if __name__ == "__main__":
    main()
