#!/usr/bin/env python3
"""Align an already-flat transparent half-body crop to the canvas bottom edge.

This helper translates an RGBA asset downward and may discard only a tiny
sub-threshold antialias tail below an already broad, stable horizontal cut.
It refuses rounded or narrow lower silhouettes so that failed framing cannot
be disguised as a valid straight canvas-edge crop.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from chroma_to_alpha import read_rgb, write_png


def align(
    input_path: Path,
    output_path: Path,
    alpha_threshold: int,
    min_bottom_contact: float,
    flat_run: int,
    max_run_variation: float,
    max_tail_contact: float,
    force: bool,
) -> None:
    if input_path.resolve() == output_path.resolve():
        raise ValueError("input and output paths must be different")
    if output_path.exists() and not force:
        raise ValueError(f"output already exists: {output_path}; pass --force to replace it")

    width, height, rgb, alpha = read_rgb(input_path)
    if alpha is None:
        raise ValueError("input must be an RGBA PNG with real transparency")

    row_contacts = [
        sum(alpha[row * width + column] > alpha_threshold for column in range(width)) / width
        for row in range(height)
    ]
    visible_rows = [row for row, contact in enumerate(row_contacts) if contact > 0]
    if not visible_rows:
        raise ValueError("input contains no visible pixels")

    broad_rows = [row for row, contact in enumerate(row_contacts) if contact >= min_bottom_contact]
    if not broad_rows:
        raise ValueError(
            f"no row spans at least {min_bottom_contact:.0%} of the canvas; "
            "this is not a broad flat crop"
        )

    crop_row = broad_rows[-1]
    if crop_row + 1 < flat_run:
        raise ValueError("not enough rows exist to verify a stable flat lower cut")
    run = row_contacts[crop_row - flat_run + 1 : crop_row + 1]
    if min(run) < min_bottom_contact or max(run) - min(run) > max_run_variation:
        raise ValueError(
            "lower contour is not broad and stable across the required row run; "
            "regenerate instead of flattening a rounded silhouette"
        )

    trailing = row_contacts[crop_row + 1 :]
    if trailing and max(trailing) > max_tail_contact:
        raise ValueError(
            f"visible material below the flat cut reaches {max(trailing):.1%} of the canvas; "
            "regenerate instead of cropping substantial content"
        )

    bottom_contact = row_contacts[crop_row]

    shift = height - 1 - crop_row
    rgba = bytearray(width * height * 4)
    for source_row in range(crop_row + 1):
        target_row = source_row + shift
        for column in range(width):
            source_index = source_row * width + column
            target_offset = (target_row * width + column) * 4
            rgb_offset = source_index * 3
            rgba[target_offset : target_offset + 3] = rgb[rgb_offset : rgb_offset + 3]
            rgba[target_offset + 3] = alpha[source_index]

    write_png(output_path, width, height, bytes(rgba), color_type=6)
    print(
        f"PASS {output_path}\n"
        f"  INFO: shifted downward {shift}px; bottom contact {bottom_contact:.1%}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--alpha-threshold", type=int, default=16)
    parser.add_argument("--min-bottom-contact", type=float, default=0.25)
    parser.add_argument("--flat-run", type=int, default=8)
    parser.add_argument("--max-run-variation", type=float, default=0.08)
    parser.add_argument("--max-tail-contact", type=float, default=0.10)
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()

    if not 0 <= args.alpha_threshold <= 255:
        parser.error("--alpha-threshold must be between 0 and 255")
    if not 0 <= args.min_bottom_contact <= 1:
        parser.error("--min-bottom-contact must be between 0 and 1")
    if args.flat_run < 2:
        parser.error("--flat-run must be at least 2")
    if not 0 <= args.max_run_variation <= 1:
        parser.error("--max-run-variation must be between 0 and 1")
    if not 0 <= args.max_tail_contact <= 1:
        parser.error("--max-tail-contact must be between 0 and 1")

    try:
        align(
            args.input,
            args.output,
            args.alpha_threshold,
            args.min_bottom_contact,
            args.flat_run,
            args.max_run_variation,
            args.max_tail_contact,
            args.force,
        )
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
