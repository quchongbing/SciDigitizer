#!/usr/bin/env python3
"""Generate reproducible line-chart fixtures with exact pixel-space truth."""

from __future__ import annotations

import argparse
import json
import math
import os
import random
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", "/tmp/sciditizer-matplotlib")

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from PIL import Image, ImageFilter


COLORS = [
    "#1769d2",
    "#d93745",
    "#159947",
    "#ef8b24",
    "#7a4cc2",
    "#009fa6",
]
LINE_STYLES = ["-", "--", "-.", ":"]
FUNCTION_NAMES = ["logistic", "gaussian", "damped", "sigmoid_peak", "power", "oscillation"]


def normalized_curve(name: str, x_normalized: np.ndarray, rng: random.Random) -> np.ndarray:
    if name == "logistic":
        center = rng.uniform(0.2, 0.75)
        slope = rng.uniform(5.0, 18.0)
        result = 1.0 / (1.0 + np.exp(-slope * (x_normalized - center)))
    elif name == "gaussian":
        center = rng.uniform(0.2, 0.8)
        width = rng.uniform(0.06, 0.24)
        result = np.exp(-0.5 * ((x_normalized - center) / width) ** 2)
    elif name == "damped":
        frequency = rng.uniform(1.0, 3.2)
        damping = rng.uniform(1.0, 4.0)
        result = 0.55 + 0.45 * np.exp(-damping * x_normalized) * np.cos(2 * np.pi * frequency * x_normalized)
    elif name == "sigmoid_peak":
        center = rng.uniform(0.15, 0.45)
        slope = rng.uniform(9.0, 20.0)
        peak = rng.uniform(0.45, 0.8)
        result = 1 / (1 + np.exp(-slope * (x_normalized - center)))
        result += rng.uniform(0.1, 0.45) * np.exp(-0.5 * ((x_normalized - peak) / rng.uniform(0.05, 0.12)) ** 2)
    elif name == "power":
        exponent = rng.uniform(0.35, 2.4)
        result = np.power(np.clip(x_normalized, 0, 1), exponent)
    else:
        frequency = rng.uniform(0.6, 2.5)
        phase = rng.uniform(0, 2 * np.pi)
        result = 0.5 + 0.42 * np.sin(2 * np.pi * frequency * x_normalized + phase)
    minimum = float(np.min(result))
    maximum = float(np.max(result))
    return (result - minimum) / max(1e-12, maximum - minimum)


def build_chart(index: int, output: Path, rng: random.Random, artifacts: bool) -> dict:
    width_px = rng.choice([560, 640, 720, 800])
    height_px = rng.choice([420, 480, 540, 600])
    dpi = 100
    figure = plt.figure(figsize=(width_px / dpi, height_px / dpi), dpi=dpi, facecolor="white")
    axes = figure.add_axes([0.14, 0.15, 0.79, 0.76])

    x_scale = "log" if rng.random() < 0.28 else "linear"
    y_scale = "log" if rng.random() < 0.08 else "linear"
    if x_scale == "log":
        x_values = np.geomspace(1e-2, 1e1, 520)
        x_normalized = (np.log10(x_values) + 2) / 3
    else:
        x_values = np.linspace(0, rng.choice([4, 6, 8, 10]), 520)
        x_normalized = (x_values - x_values.min()) / (x_values.max() - x_values.min())

    series_count = rng.randint(1, 5)
    selected_colors = rng.sample(COLORS, k=series_count)
    series_records = []
    for series_index in range(series_count):
        family = rng.choice(FUNCTION_NAMES)
        normalized = normalized_curve(family, x_normalized, rng)
        amplitude = rng.uniform(0.35, 1.1)
        offset = rng.uniform(0.02, 0.35)
        y_values = offset + amplitude * normalized
        if y_scale == "log":
            y_values = 10 ** (-2 + 2.2 * (y_values - y_values.min()) / max(1e-12, np.ptp(y_values)))
        style = rng.choice(LINE_STYLES)
        marker = rng.choice([None, None, None, "o", "s", "^"])
        markevery = rng.randint(22, 48) if marker else None
        label = f"model {series_index + 1} · {family}"
        line, = axes.plot(
            x_values,
            y_values,
            color=selected_colors[series_index],
            linestyle=style,
            linewidth=rng.uniform(1.2, 2.4),
            marker=marker,
            markersize=rng.uniform(3.0, 6.0) if marker else 0,
            markevery=markevery,
            label=label,
        )
        series_records.append({
            "label": label,
            "family": family,
            "color": list(matplotlib.colors.to_rgb(line.get_color())),
            "lineStyle": style,
            "marker": marker,
            "x": x_values.tolist(),
            "y": y_values.tolist(),
        })

    axes.set_xscale(x_scale)
    axes.set_yscale(y_scale)
    axes.set_xlabel(rng.choice([r"$k$ [Å$^{-1}$]", r"$r/a_B$", r"$\rho$ [g cm$^{-3}$]"]))
    axes.set_ylabel(rng.choice([r"$S(k)$", r"$g(r)$", r"$P/n_i k_B T$"]))
    axes.set_title(rng.choice(["Synthetic WDM benchmark", "Warm dense matter models", "Structure comparison"]))
    if rng.random() < 0.48:
        axes.grid(True, color="#b9c0c8", alpha=rng.uniform(0.2, 0.55), linewidth=0.7)
    legend_locations = ["best", "upper right", "lower right", "upper left", "center right"]
    axes.legend(loc=rng.choice(legend_locations), fontsize=rng.choice([7, 8, 9]), framealpha=rng.uniform(0.72, 1.0))
    axes.tick_params(direction=rng.choice(["in", "out"]), top=True, right=True)

    figure.canvas.draw()
    canvas_width, canvas_height = figure.canvas.get_width_height()
    rgba = np.asarray(figure.canvas.buffer_rgba()).copy()
    axes_bbox = axes.get_window_extent()
    plot_rect = {
        "left": round(axes_bbox.x0) + 1,
        "top": round(canvas_height - axes_bbox.y1) + 1,
        "right": round(axes_bbox.x1) - 1,
        "bottom": round(canvas_height - axes_bbox.y0) - 1,
    }
    plot_rect["width"] = plot_rect["right"] - plot_rect["left"] + 1
    plot_rect["height"] = plot_rect["bottom"] - plot_rect["top"] + 1

    for record in series_records:
        data_points = np.column_stack([record["x"], record["y"]])
        display_points = axes.transData.transform(data_points)
        record["pixelX"] = display_points[:, 0].tolist()
        record["pixelY"] = (canvas_height - display_points[:, 1]).tolist()
        record["color"] = [round(channel * 255) for channel in record["color"]]

    image = Image.fromarray(rgba, mode="RGBA").convert("RGB")
    artifact_record = {"blurRadius": 0.0, "jpegQuality": None}
    if artifacts:
        if rng.random() < 0.38:
            blur_radius = rng.uniform(0.15, 0.65)
            image = image.filter(ImageFilter.GaussianBlur(radius=blur_radius))
            artifact_record["blurRadius"] = blur_radius
        if rng.random() < 0.55:
            quality = rng.randint(58, 90)
            temporary_jpeg = output / f".tmp-{index:04d}.jpg"
            image.save(temporary_jpeg, quality=quality, subsampling=2)
            image = Image.open(temporary_jpeg).convert("RGB")
            temporary_jpeg.unlink()
            artifact_record["jpegQuality"] = quality

    stem = f"chart-{index:04d}"
    image.save(output / f"{stem}.png")
    record = {
        "id": stem,
        "image": f"{stem}.png",
        "width": canvas_width,
        "height": canvas_height,
        "plotRect": plot_rect,
        "xScale": x_scale,
        "yScale": y_scale,
        "artifacts": artifact_record,
        "series": series_records,
    }
    (output / f"{stem}.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    plt.close(figure)
    return {"id": stem, "metadata": f"{stem}.json", "image": f"{stem}.png"}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=50)
    parser.add_argument("--seed", type=int, default=20260719)
    parser.add_argument("--output", type=Path, default=Path("benchmarks/generated"))
    parser.add_argument("--no-artifacts", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    manifest = {
        "schemaVersion": 1,
        "seed": args.seed,
        "count": args.count,
        "charts": [
            build_chart(index, args.output, rng, not args.no_artifacts)
            for index in range(args.count)
        ],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"generated {args.count} charts in {args.output}")


if __name__ == "__main__":
    main()
