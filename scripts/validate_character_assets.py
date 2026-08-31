#!/usr/bin/env python3
"""Validate transparent PNG character assets using only the Python standard library."""

from __future__ import annotations

import argparse
import binascii
import struct
import sys
import zlib
from dataclasses import dataclass, field
from pathlib import Path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


@dataclass
class Result:
    path: Path
    failures: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.failures


def paeth(a: int, b: int, c: int) -> int:
    prediction = a + b - c
    pa = abs(prediction - a)
    pb = abs(prediction - b)
    pc = abs(prediction - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def parse_chunks(data: bytes) -> list[tuple[bytes, bytes]]:
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError("not a PNG file")

    chunks: list[tuple[bytes, bytes]] = []
    offset = len(PNG_SIGNATURE)
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("truncated PNG chunk header")
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload_start = offset + 8
        payload_end = payload_start + length
        crc_end = payload_end + 4
        if crc_end > len(data):
            raise ValueError(f"truncated {kind.decode('ascii', 'replace')} chunk")
        payload = data[payload_start:payload_end]
        expected_crc = struct.unpack(">I", data[payload_end:crc_end])[0]
        actual_crc = binascii.crc32(kind + payload) & 0xFFFFFFFF
        if actual_crc != expected_crc:
            raise ValueError(f"CRC mismatch in {kind.decode('ascii', 'replace')} chunk")
        chunks.append((kind, payload))
        offset = crc_end
        if kind == b"IEND":
            break
    return chunks


def unfilter_rows(raw: bytes, width: int, height: int, bytes_per_pixel: int) -> list[bytes]:
    stride = width * bytes_per_pixel
    expected = height * (stride + 1)
    if len(raw) != expected:
        raise ValueError(f"unexpected pixel data length: expected {expected}, got {len(raw)}")

    rows: list[bytes] = []
    offset = 0
    previous = bytearray(stride)
    for _ in range(height):
        filter_type = raw[offset]
        scanline = raw[offset + 1 : offset + 1 + stride]
        offset += stride + 1
        current = bytearray(stride)
        for index, value in enumerate(scanline):
            left = current[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            up = previous[index]
            up_left = previous[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
            if filter_type == 0:
                reconstructed = value
            elif filter_type == 1:
                reconstructed = value + left
            elif filter_type == 2:
                reconstructed = value + up
            elif filter_type == 3:
                reconstructed = value + ((left + up) // 2)
            elif filter_type == 4:
                reconstructed = value + paeth(left, up, up_left)
            else:
                raise ValueError(f"unsupported PNG filter type {filter_type}")
            current[index] = reconstructed & 0xFF
        rows.append(bytes(current))
        previous = current
    return rows


def alpha_values(
    rows: list[bytes], width: int, color_type: int, transparency: bytes | None
) -> list[list[int]]:
    alphas: list[list[int]] = []
    for row in rows:
        if color_type == 6:  # RGBA
            alphas.append([row[index + 3] for index in range(0, width * 4, 4)])
        elif color_type == 4:  # grayscale + alpha
            alphas.append([row[index + 1] for index in range(0, width * 2, 2)])
        elif color_type == 3 and transparency is not None:  # indexed + tRNS
            alphas.append([transparency[value] if value < len(transparency) else 255 for value in row[:width]])
        elif color_type == 0 and transparency is not None:  # grayscale + tRNS
            transparent_sample = struct.unpack(">H", transparency[:2])[0] & 0xFF
            alphas.append([0 if value == transparent_sample else 255 for value in row[:width]])
        elif color_type == 2 and transparency is not None:  # RGB + tRNS
            transparent_rgb = tuple(value & 0xFF for value in struct.unpack(">HHH", transparency[:6]))
            pixels = []
            for index in range(0, width * 3, 3):
                pixels.append(0 if tuple(row[index : index + 3]) == transparent_rgb else 255)
            alphas.append(pixels)
        else:
            raise ValueError("PNG has no readable alpha information")
    return alphas


def validate(
    path: Path,
    min_size: int,
    edge_threshold: float,
    min_clear_transparent_ratio: float,
    min_clear_border_ratio: float,
    allow_bottom_touch: bool,
    require_bottom_touch: bool,
    min_bottom_contact: float,
) -> Result:
    result = Result(path=path)
    try:
        data = path.read_bytes()
        chunks = parse_chunks(data)
        chunk_map: dict[bytes, list[bytes]] = {}
        for kind, payload in chunks:
            chunk_map.setdefault(kind, []).append(payload)

        if b"IHDR" not in chunk_map:
            raise ValueError("missing IHDR chunk")
        width, height, bit_depth, color_type, compression, filter_method, interlace = struct.unpack(
            ">IIBBBBB", chunk_map[b"IHDR"][0]
        )
        result.notes.append(f"{width}x{height}, bit depth {bit_depth}, color type {color_type}")

        if width < min_size or height < min_size:
            result.failures.append(f"dimensions are below {min_size}px on at least one edge")
        if compression != 0 or filter_method != 0:
            result.failures.append("uses an unsupported PNG compression or filter method")

        transparency = chunk_map.get(b"tRNS", [None])[0]
        has_alpha = color_type in (4, 6) or transparency is not None
        if not has_alpha:
            result.failures.append("has no alpha channel or tRNS transparency")
            return result

        if bit_depth != 8 or interlace != 0:
            result.warnings.append(
                "alpha exists, but pixel-level analysis supports only 8-bit non-interlaced PNGs"
            )
            return result

        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
        if channels is None:
            result.failures.append(f"unsupported PNG color type {color_type}")
            return result

        raw = zlib.decompress(b"".join(chunk_map.get(b"IDAT", [])))
        rows = unfilter_rows(raw, width, height, channels)
        alpha = alpha_values(rows, width, color_type, transparency)
        flat = [value for row in alpha for value in row]
        total = len(flat)
        any_transparent = sum(value < 250 for value in flat)
        clear_transparent = sum(value <= 16 for value in flat)
        semitransparent = sum(16 < value < 250 for value in flat)
        visible = sum(value > 5 for value in flat)
        transparent_ratio = any_transparent / total
        clear_transparent_ratio = clear_transparent / total
        semitransparent_ratio = semitransparent / total
        visible_ratio = visible / total
        result.notes.append(
            "alpha: "
            f"any transparent {transparent_ratio:.1%}; "
            f"clear transparent {clear_transparent_ratio:.1%}; "
            f"semi-transparent {semitransparent_ratio:.1%}; "
            f"visible content {visible_ratio:.1%}"
        )

        if clear_transparent_ratio < min_clear_transparent_ratio:
            result.failures.append(
                f"fewer than {min_clear_transparent_ratio:.0%} of pixels are clearly transparent "
                "(alpha <= 16); background is likely still present"
            )
        if visible_ratio < 0.05:
            result.failures.append("fewer than 5% of pixels contain visible content; asset may be empty")
        if semitransparent_ratio > 0.35:
            result.warnings.append(
                "more than 35% of pixels are semi-transparent; inspect for a translucent background haze"
            )

        edges = {
            "top": alpha[0],
            "bottom": alpha[-1],
            "left": [row[0] for row in alpha],
            "right": [row[-1] for row in alpha],
        }

        border_names = ("top", "left", "right") if allow_bottom_touch else (
            "top",
            "bottom",
            "left",
            "right",
        )
        border = [value for name in border_names for value in edges[name]]
        clear_border_ratio = sum(value <= 16 for value in border) / len(border)
        border_label = "top/left/right border" if allow_bottom_touch else "outer border"
        result.notes.append(f"clearly transparent {border_label} {clear_border_ratio:.1%}")
        if clear_border_ratio < min_clear_border_ratio:
            result.failures.append(
                f"less than {min_clear_border_ratio:.0%} of the outer border is clearly transparent; "
                "the asset likely retains a rectangular background"
            )

        corners = {
            "top-left": alpha[0][0],
            "top-right": alpha[0][-1],
            "bottom-left": alpha[-1][0],
            "bottom-right": alpha[-1][-1],
        }
        opaque_corners = [name for name, value in corners.items() if value > 16]
        result.notes.append(
            "corner alpha " + ", ".join(f"{name}={value}" for name, value in corners.items())
        )
        if opaque_corners:
            result.failures.append(
                "corner pixel(s) are not clearly transparent: " + ", ".join(opaque_corners)
            )
        contacts = {
            name: sum(value > 16 for value in values) / len(values)
            for name, values in edges.items()
        }
        result.notes.append(
            "edge contact " + ", ".join(f"{name} {ratio:.1%}" for name, ratio in contacts.items())
        )
        if require_bottom_touch and contacts["bottom"] < min_bottom_contact:
            result.failures.append(
                f"bottom edge contact is {contacts['bottom']:.1%}; default half-body assets require "
                f"at least {min_bottom_contact:.0%} broad contact for a true canvas-edge crop"
            )
        risky = [
            name
            for name, ratio in contacts.items()
            if ratio > edge_threshold and not (allow_bottom_touch and name == "bottom")
        ]
        if risky:
            result.warnings.append(
                "visible content heavily touches edge(s): "
                + ", ".join(risky)
                + "; inspect for accidental clipping"
            )
        if allow_bottom_touch and contacts["bottom"] > edge_threshold:
            result.notes.append("bottom edge contact accepted as an intentional half-body crop")
    except (OSError, ValueError, struct.error, zlib.error) as exc:
        result.failures.append(str(exc))
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="PNG assets to validate")
    parser.add_argument("--min-size", type=int, default=512, help="minimum width and height (default: 512)")
    parser.add_argument(
        "--edge-threshold",
        type=float,
        default=0.25,
        help="warn when visible content touches more than this fraction of an edge (default: 0.25)",
    )
    parser.add_argument(
        "--min-clear-transparent-ratio",
        type=float,
        default=0.08,
        help="fail if fewer than this fraction of pixels have alpha <= 16 (default: 0.08)",
    )
    parser.add_argument(
        "--min-clear-border-ratio",
        type=float,
        default=0.70,
        help="fail if less than this fraction of the outer border has alpha <= 16 (default: 0.70)",
    )
    parser.add_argument(
        "--allow-bottom-touch",
        action="store_true",
        help="allow an intentional half-body portrait crop to touch only the bottom edge",
    )
    parser.add_argument(
        "--require-bottom-touch",
        action="store_true",
        help="require a broad intentional half-body crop to contact the bottom edge",
    )
    parser.add_argument(
        "--min-bottom-contact",
        type=float,
        default=0.25,
        help="minimum visible fraction of the bottom edge when contact is required (default: 0.25)",
    )
    args = parser.parse_args()

    if not 0 <= args.edge_threshold <= 1:
        parser.error("--edge-threshold must be between 0 and 1")
    if args.min_size < 1:
        parser.error("--min-size must be positive")
    if not 0 <= args.min_clear_transparent_ratio <= 1:
        parser.error("--min-clear-transparent-ratio must be between 0 and 1")
    if not 0 <= args.min_clear_border_ratio <= 1:
        parser.error("--min-clear-border-ratio must be between 0 and 1")
    if not 0 <= args.min_bottom_contact <= 1:
        parser.error("--min-bottom-contact must be between 0 and 1")

    allow_bottom_touch = args.allow_bottom_touch or args.require_bottom_touch

    results = [
        validate(
            path,
            args.min_size,
            args.edge_threshold,
            args.min_clear_transparent_ratio,
            args.min_clear_border_ratio,
            allow_bottom_touch,
            args.require_bottom_touch,
            args.min_bottom_contact,
        )
        for path in args.paths
    ]
    for result in results:
        status = "PASS" if result.ok else "FAIL"
        print(f"{status} {result.path}")
        for note in result.notes:
            print(f"  INFO: {note}")
        for warning in result.warnings:
            print(f"  WARN: {warning}")
        for failure in result.failures:
            print(f"  FAIL: {failure}")

    passed = sum(result.ok for result in results)
    print(f"\nSummary: {passed}/{len(results)} asset(s) passed")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
