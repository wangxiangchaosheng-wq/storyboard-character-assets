#!/usr/bin/env python3
"""Convert a purpose-generated uniform chroma background into PNG alpha.

This is intentionally narrow: use it only on character drafts generated on a
known flat matte color. It is not a general photo background-removal tool.
"""

from __future__ import annotations

import argparse
import binascii
import math
import struct
import sys
import zlib
from array import array
from collections import deque
from pathlib import Path

from validate_character_assets import parse_chunks, unfilter_rows


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def parse_hex_color(value: str) -> tuple[int, int, int]:
    text = value.strip().lstrip("#")
    if len(text) != 6:
        raise argparse.ArgumentTypeError("colors must use #RRGGBB format")
    try:
        return tuple(int(text[index : index + 2], 16) for index in (0, 2, 4))  # type: ignore[return-value]
    except ValueError as exc:
        raise argparse.ArgumentTypeError("colors must use #RRGGBB format") from exc


def read_rgb(path: Path) -> tuple[int, int, bytearray, bytearray | None]:
    chunks = parse_chunks(path.read_bytes())
    chunk_map: dict[bytes, list[bytes]] = {}
    for kind, payload in chunks:
        chunk_map.setdefault(kind, []).append(payload)

    if b"IHDR" not in chunk_map:
        raise ValueError("missing IHDR chunk")
    width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
        ">IIBBBBB", chunk_map[b"IHDR"][0]
    )
    if bit_depth != 8 or interlace != 0:
        raise ValueError("only 8-bit non-interlaced PNG input is supported")
    if compression != 0 or filter_method != 0:
        raise ValueError("unsupported PNG compression or filter method")
    if color_type not in (2, 6):
        raise ValueError("input must be an RGB or RGBA PNG")

    channels = 3 if color_type == 2 else 4
    raw = zlib.decompress(b"".join(chunk_map.get(b"IDAT", [])))
    rows = unfilter_rows(raw, width, height, channels)
    rgb = bytearray(width * height * 3)
    source_alpha = bytearray(width * height) if channels == 4 else None

    pixel_index = 0
    rgb_index = 0
    for row in rows:
        for offset in range(0, len(row), channels):
            rgb[rgb_index : rgb_index + 3] = row[offset : offset + 3]
            if source_alpha is not None:
                source_alpha[pixel_index] = row[offset + 3]
            pixel_index += 1
            rgb_index += 3
    return width, height, rgb, source_alpha


def png_chunk(kind: bytes, payload: bytes) -> bytes:
    crc = binascii.crc32(kind + payload) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", crc)


def write_png(path: Path, width: int, height: int, pixels: bytes, color_type: int) -> None:
    channels = 4 if color_type == 6 else 3
    expected = width * height * channels
    if len(pixels) != expected:
        raise ValueError(f"pixel buffer mismatch: expected {expected}, got {len(pixels)}")

    raw = bytearray()
    stride = width * channels
    for row in range(height):
        raw.append(0)
        start = row * stride
        raw.extend(pixels[start : start + stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    encoded = bytearray(PNG_SIGNATURE)
    encoded.extend(png_chunk(b"IHDR", ihdr))
    encoded.extend(png_chunk(b"sRGB", b"\x00"))
    encoded.extend(png_chunk(b"IDAT", zlib.compress(bytes(raw), level=9)))
    encoded.extend(png_chunk(b"IEND", b""))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded)


def nearest_key_distance_sq(
    red: int, green: int, blue: int, keys: list[tuple[int, int, int]]
) -> int:
    return min(
        (red - key_red) ** 2 + (green - key_green) ** 2 + (blue - key_blue) ** 2
        for key_red, key_green, key_blue in keys
    )


def nearest_key(
    red: int, green: int, blue: int, keys: list[tuple[int, int, int]]
) -> tuple[int, int, int]:
    return min(
        keys,
        key=lambda key: (red - key[0]) ** 2 + (green - key[1]) ** 2 + (blue - key[2]) ** 2,
    )


def border_indices(width: int, height: int) -> list[int]:
    indices = list(range(width))
    indices.extend(range((height - 1) * width, height * width))
    for row in range(1, height - 1):
        indices.append(row * width)
        indices.append(row * width + width - 1)
    return indices


def connected_mask(candidates: bytearray, width: int, height: int) -> bytearray:
    total = width * height
    mask = bytearray(total)
    queue: deque[int] = deque()
    for index in border_indices(width, height):
        if candidates[index] and not mask[index]:
            mask[index] = 1
            queue.append(index)

    while queue:
        index = queue.popleft()
        row, column = divmod(index, width)
        if column > 0:
            neighbor = index - 1
            if candidates[neighbor] and not mask[neighbor]:
                mask[neighbor] = 1
                queue.append(neighbor)
        if column + 1 < width:
            neighbor = index + 1
            if candidates[neighbor] and not mask[neighbor]:
                mask[neighbor] = 1
                queue.append(neighbor)
        if row > 0:
            neighbor = index - width
            if candidates[neighbor] and not mask[neighbor]:
                mask[neighbor] = 1
                queue.append(neighbor)
        if row + 1 < height:
            neighbor = index + width
            if candidates[neighbor] and not mask[neighbor]:
                mask[neighbor] = 1
                queue.append(neighbor)
    return mask


def neighbor_indices(index: int, width: int, height: int):
    row, column = divmod(index, width)
    if column > 0:
        yield index - 1
    if column + 1 < width:
        yield index + 1
    if row > 0:
        yield index - width
    if row + 1 < height:
        yield index + width


def limited_feather_mask(
    hard_mask: bytearray,
    eligible: bytearray,
    width: int,
    height: int,
    radius: int,
) -> bytearray:
    """Grow the hard matte only through key-like pixels near its boundary.

    Limiting the spatial radius prevents dark or muted subject colors that are
    numerically near the key from becoming translucent across the whole asset.
    """

    result = bytearray(hard_mask)
    if radius <= 0:
        return result

    frontier: list[int] = []
    for index, is_eligible in enumerate(eligible):
        if is_eligible and not result[index]:
            if any(hard_mask[neighbor] for neighbor in neighbor_indices(index, width, height)):
                result[index] = 1
                frontier.append(index)

    for _ in range(1, radius):
        next_frontier: list[int] = []
        for index in frontier:
            for neighbor in neighbor_indices(index, width, height):
                if eligible[neighbor] and not result[neighbor]:
                    result[neighbor] = 1
                    next_frontier.append(neighbor)
        if not next_frontier:
            break
        frontier = next_frontier
    return result


def nearest_opaque_color(
    index: int,
    rgb: bytearray,
    feather_mask: bytearray,
    width: int,
    height: int,
    search_radius: int,
) -> tuple[int, int, int] | None:
    """Estimate foreground color from the nearest fully opaque subject pixels."""

    row, column = divmod(index, width)
    for radius in range(1, search_radius + 1):
        samples: list[tuple[int, int, int]] = []
        top = max(0, row - radius)
        bottom = min(height - 1, row + radius)
        left = max(0, column - radius)
        right = min(width - 1, column + radius)

        for sample_column in range(left, right + 1):
            for sample_row in (top, bottom):
                sample_index = sample_row * width + sample_column
                if not feather_mask[sample_index]:
                    offset = sample_index * 3
                    samples.append(tuple(rgb[offset : offset + 3]))  # type: ignore[arg-type]
        for sample_row in range(top + 1, bottom):
            for sample_column in (left, right):
                sample_index = sample_row * width + sample_column
                if not feather_mask[sample_index]:
                    offset = sample_index * 3
                    samples.append(tuple(rgb[offset : offset + 3]))  # type: ignore[arg-type]

        if samples:
            count = len(samples)
            return tuple(
                round(sum(sample[channel] for sample in samples) / count)
                for channel in range(3)
            )  # type: ignore[return-value]
    return None


def composite_preview(rgba: bytes, background: tuple[int, int, int]) -> bytes:
    preview = bytearray((len(rgba) // 4) * 3)
    output_index = 0
    for offset in range(0, len(rgba), 4):
        alpha = rgba[offset + 3] / 255.0
        for channel in range(3):
            value = round(rgba[offset + channel] * alpha + background[channel] * (1.0 - alpha))
            preview[output_index] = max(0, min(255, value))
            output_index += 1
    return bytes(preview)


def convert(
    input_path: Path,
    output_path: Path,
    keys: list[tuple[int, int, int]],
    tolerance: int,
    feather: int,
    feather_radius: int,
    mode: str,
    min_border_coverage: float,
    min_background: float,
    max_background: float,
    max_edge_contact: float,
    allow_bottom_touch: bool,
    preview_dir: Path | None,
    force: bool,
) -> None:
    if input_path.resolve() == output_path.resolve():
        raise ValueError("input and output paths must be different")
    if output_path.exists() and not force:
        raise ValueError(f"output already exists: {output_path}; pass --force to replace it")

    width, height, rgb, source_alpha = read_rgb(input_path)
    if source_alpha is not None and any(value < 250 for value in source_alpha):
        raise ValueError("input already contains transparency; preserve it instead of chroma conversion")

    total = width * height
    tolerance_sq = tolerance * tolerance
    feather_sq = feather * feather
    distances = array("I", [0]) * total
    candidates = bytearray(total)
    feather_candidates = bytearray(total)
    for index in range(total):
        offset = index * 3
        distance_sq = nearest_key_distance_sq(rgb[offset], rgb[offset + 1], rgb[offset + 2], keys)
        distances[index] = distance_sq
        if distance_sq <= tolerance_sq:
            candidates[index] = 1
        if distance_sq < feather_sq:
            feather_candidates[index] = 1

    borders = border_indices(width, height)
    border_coverage = sum(candidates[index] for index in borders) / len(borders)
    if border_coverage < min_border_coverage:
        raise ValueError(
            f"matte covers only {border_coverage:.1%} of the canvas border; "
            f"expected at least {min_border_coverage:.1%}"
        )

    mask = candidates if mode == "all" else connected_mask(candidates, width, height)
    feather_mask = limited_feather_mask(
        mask,
        feather_candidates,
        width,
        height,
        feather_radius,
    )
    background_pixels = sum(mask)
    background_ratio = background_pixels / total
    if background_ratio < min_background or background_ratio > max_background:
        raise ValueError(
            f"background coverage {background_ratio:.1%} is outside the allowed "
            f"{min_background:.1%}–{max_background:.1%} range"
        )

    alpha = bytearray([255]) * total
    for index, is_background in enumerate(mask):
        if is_background:
            alpha[index] = 0

    foreground_estimates: dict[int, tuple[int, int, int]] = {}
    if feather > tolerance:
        search_radius = max(4, feather_radius * 2)
        for index in range(total):
            if mask[index] or not feather_mask[index]:
                continue

            rgb_offset = index * 3
            current = tuple(rgb[rgb_offset : rgb_offset + 3])
            key = nearest_key(*current, keys)
            foreground = nearest_opaque_color(
                index,
                rgb,
                feather_mask,
                width,
                height,
                search_radius,
            )
            if foreground is not None:
                foreground_estimates[index] = foreground
                observed_vector = tuple(current[channel] - key[channel] for channel in range(3))
                foreground_vector = tuple(
                    foreground[channel] - key[channel] for channel in range(3)
                )
                denominator = sum(value * value for value in foreground_vector)
                if denominator:
                    alpha_fraction = sum(
                        observed_vector[channel] * foreground_vector[channel]
                        for channel in range(3)
                    ) / denominator
                else:
                    alpha_fraction = 1.0
            else:
                alpha_fraction = math.sqrt(distances[index]) / 360.0

            alpha[index] = max(1, min(254, round(255 * alpha_fraction)))

    edge_sets = {
        "top": range(width),
        "bottom": range((height - 1) * width, height * width),
        "left": (row * width for row in range(height)),
        "right": (row * width + width - 1 for row in range(height)),
    }
    contacts: dict[str, float] = {}
    for name, indices in edge_sets.items():
        values = list(indices)
        contacts[name] = sum(alpha[index] > 16 for index in values) / len(values)
    risky_edges = [
        name
        for name, ratio in contacts.items()
        if ratio > max_edge_contact and not (allow_bottom_touch and name == "bottom")
    ]
    if risky_edges:
        raise ValueError(
            "subject touches canvas edge(s): "
            + ", ".join(risky_edges)
            + "; regenerate with more matte margin"
        )

    rgba = bytearray(total * 4)
    for index in range(total):
        rgb_offset = index * 3
        rgba_offset = index * 4
        alpha_value = alpha[index]
        if alpha_value == 0:
            rgba[rgba_offset : rgba_offset + 4] = b"\x00\x00\x00\x00"
            continue

        red, green, blue = rgb[rgb_offset : rgb_offset + 3]
        if index in foreground_estimates:
            red, green, blue = foreground_estimates[index]
        elif alpha_value < 255:
            key_red, key_green, key_blue = nearest_key(red, green, blue, keys)
            alpha_fraction = alpha_value / 255.0
            red = round((red - (1.0 - alpha_fraction) * key_red) / alpha_fraction)
            green = round((green - (1.0 - alpha_fraction) * key_green) / alpha_fraction)
            blue = round((blue - (1.0 - alpha_fraction) * key_blue) / alpha_fraction)
        rgba[rgba_offset] = max(0, min(255, red))
        rgba[rgba_offset + 1] = max(0, min(255, green))
        rgba[rgba_offset + 2] = max(0, min(255, blue))
        rgba[rgba_offset + 3] = alpha_value

    write_png(output_path, width, height, bytes(rgba), color_type=6)
    if preview_dir is not None:
        preview_dir.mkdir(parents=True, exist_ok=True)
        stem = output_path.stem
        write_png(
            preview_dir / f"{stem}-on-black.png",
            width,
            height,
            composite_preview(bytes(rgba), (0, 0, 0)),
            color_type=2,
        )
        write_png(
            preview_dir / f"{stem}-on-white.png",
            width,
            height,
            composite_preview(bytes(rgba), (255, 255, 255)),
            color_type=2,
        )

    key_labels = ", ".join(f"#{red:02X}{green:02X}{blue:02X}" for red, green, blue in keys)
    contact_label = ", ".join(f"{name} {ratio:.1%}" for name, ratio in contacts.items())
    print(f"PASS {output_path}")
    print(
        f"  INFO: {width}x{height}; key {key_labels}; mode {mode}; "
        f"tolerance {tolerance}; feather {feather}; feather radius {feather_radius}px"
    )
    print(f"  INFO: matte border coverage {border_coverage:.1%}; removed {background_ratio:.1%}")
    print(f"  INFO: output edge contact {contact_label}")
    if allow_bottom_touch and contacts["bottom"] > max_edge_contact:
        print("  INFO: bottom edge contact accepted as an intentional half-body crop")
    if preview_dir is not None:
        print(f"  INFO: QA previews saved to {preview_dir}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path, help="purpose-generated PNG on a uniform chroma matte")
    parser.add_argument("output", type=Path, help="new RGBA PNG path")
    parser.add_argument(
        "--key",
        action="append",
        type=parse_hex_color,
        help="matte color in #RRGGBB form; repeat for multiple colors (default: #FF00FF)",
    )
    parser.add_argument("--tolerance", type=int, default=200, help="hard color distance, 0–441 (default: 200)")
    parser.add_argument("--feather", type=int, default=300, help="soft edge color distance, 1–441 (default: 300)")
    parser.add_argument(
        "--feather-radius",
        type=int,
        default=5,
        help="maximum spatial width of the soft matte edge in pixels (default: 5)",
    )
    parser.add_argument(
        "--mode",
        choices=("all", "connected"),
        default="all",
        help="remove all matte matches or only edge-connected matches (default: all)",
    )
    parser.add_argument(
        "--min-border-coverage",
        type=float,
        default=0.70,
        help="minimum fraction of border matching the matte (default: 0.70)",
    )
    parser.add_argument("--min-background", type=float, default=0.05, help="minimum removable area (default: 0.05)")
    parser.add_argument("--max-background", type=float, default=0.95, help="maximum removable area (default: 0.95)")
    parser.add_argument(
        "--max-edge-contact",
        type=float,
        default=0.01,
        help="maximum visible fraction on any canvas edge (default: 0.01)",
    )
    parser.add_argument(
        "--allow-bottom-touch",
        action="store_true",
        help="allow an intentional half-body portrait crop to touch only the bottom edge",
    )
    parser.add_argument("--preview-dir", type=Path, help="optional directory for black/white QA previews")
    parser.add_argument("--force", action="store_true", help="replace an existing output file")
    args = parser.parse_args()

    if not 0 <= args.tolerance <= 441:
        parser.error("--tolerance must be between 0 and 441")
    if not 1 <= args.feather <= 441:
        parser.error("--feather must be between 1 and 441")
    if args.feather <= args.tolerance:
        parser.error("--feather must be greater than --tolerance")
    if not 1 <= args.feather_radius <= 32:
        parser.error("--feather-radius must be between 1 and 32")
    for name in ("min_border_coverage", "min_background", "max_background", "max_edge_contact"):
        value = getattr(args, name)
        if not 0 <= value <= 1:
            parser.error(f"--{name.replace('_', '-')} must be between 0 and 1")
    if args.min_background >= args.max_background:
        parser.error("--min-background must be less than --max-background")

    try:
        convert(
            input_path=args.input,
            output_path=args.output,
            keys=args.key or [(255, 0, 255)],
            tolerance=args.tolerance,
            feather=args.feather,
            feather_radius=args.feather_radius,
            mode=args.mode,
            min_border_coverage=args.min_border_coverage,
            min_background=args.min_background,
            max_background=args.max_background,
            max_edge_contact=args.max_edge_contact,
            allow_bottom_touch=args.allow_bottom_touch,
            preview_dir=args.preview_dir,
            force=args.force,
        )
    except (OSError, ValueError, struct.error, zlib.error) as exc:
        print(f"FAIL {args.input}\n  FAIL: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
