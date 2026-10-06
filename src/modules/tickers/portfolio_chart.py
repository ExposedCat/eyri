import json
import math
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
from matplotlib.patches import PathPatch
from matplotlib.path import Path
from matplotlib.ticker import FuncFormatter


def capped_bar(axis, index, height, color):
	# Round only the outer end; keep the baseline flat and the height exact.
	width = .48
	pixels_x = axis.transData.transform((1, 0))[0] - axis.transData.transform((0, 0))[0]
	pixels_y = axis.transData.transform((0, 1))[1] - axis.transData.transform((0, 0))[1]
	radius_y = min(width / 2 * pixels_x / pixels_y, abs(height))
	radius_x = radius_y * pixels_y / pixels_x
	left, right, top = index - width / 2, index + width / 2, abs(height)
	k = .5522847498  # Cubic approximation of a quarter circle.
	vertices = [
		(left, 0), (left, top - radius_y),
		(left, top - radius_y + k * radius_y),
		(left + radius_x - k * radius_x, top), (left + radius_x, top),
		(right - radius_x, top), (right - radius_x + k * radius_x, top),
		(right, top - radius_y + k * radius_y), (right, top - radius_y),
		(right, 0), (left, 0),
	]
	if height < 0:
		vertices = [(x, -y) for x, y in vertices]
	codes = [Path.MOVETO, Path.LINETO, Path.CURVE4, Path.CURVE4, Path.CURVE4,
		Path.LINETO, Path.CURVE4, Path.CURVE4, Path.CURVE4, Path.LINETO, Path.CLOSEPOLY]
	axis.add_patch(PathPatch(Path(vertices, codes), facecolor=color, edgecolor="none", zorder=3))


def render(chart):
	holdings = chart["holdings"]
	background = "#101820"
	foreground = "#F3F6F9"
	muted = "#B1BFCE"
	green = "#63D8AB"
	red = "#FA8991"
	plt.rcParams.update({
		"font.family": "DejaVu Sans",
		"text.color": foreground,
		"text.parse_math": False,
		"text.antialiased": True,
		"text.hinting": "auto",
	})
	width = max(12, len(holdings) * 1.25 + .8)
	figure = plt.figure(figsize=(width, 8), dpi=200, facecolor=background)
	# Keep margins fixed in inches, so wide portfolios retain their bar spacing.
	left, right = .9 / width, .45 / width
	plot_width = 1 - left - right
	figure.text(left, .937, "STOCK ALLOCATION", fontsize=11, fontweight="bold", color=muted)
	figure.text(left, .865, chart["total"], fontsize=32, fontweight="bold")
	count = chart["holdingsCount"]
	figure.text(left, .822, f"{count} {'holding' if count == 1 else 'holdings'}  ·  Allocation by market value", fontsize=12, color=muted)
	axis = figure.add_axes([left, .245, plot_width, .525], facecolor=background)
	positive_max = max((holding["weight"] for holding in holdings if holding["change"] is None or holding["change"] >= 0), default=0)
	negative_max = max((holding["weight"] for holding in holdings if holding["change"] is not None and holding["change"] < 0), default=0)
	scale = max(positive_max + negative_max, 1) / 50
	axis.set_ylim(-negative_max - 10 * scale, positive_max + 10 * scale)
	axis.set_xlim(-.65, len(holdings) - .35)
	raw_step = max(positive_max + negative_max, 1) / 5
	magnitude = 10 ** math.floor(math.log10(raw_step))
	step = next(factor * magnitude for factor in (1, 2, 5, 10) if factor * magnitude >= raw_step)
	lower_tick = math.ceil((-negative_max - 3 * scale) / step)
	upper_tick = math.floor((positive_max + 3 * scale) / step)
	axis.set_yticks([index * step for index in range(lower_tick, upper_tick + 1)])
	axis.yaxis.set_major_formatter(FuncFormatter(lambda value, position: "0" if value == 0 else f"{abs(value):g}%"))
	axis.tick_params(axis="y", colors=muted, labelsize=11, length=0, pad=10)
	axis.set_axisbelow(True)
	axis.grid(axis="y", color="#24313F", linewidth=.75)
	axis.axhline(0, color="#8494A6", linewidth=1.3, zorder=2)
	for spine in axis.spines.values():
		spine.set_visible(False)
	figure.add_artist(Line2D([left, 1 - right], [.212, .212], transform=figure.transFigure, color="#2C3A48", linewidth=1))
	for index, holding in enumerate(holdings):
		change = holding["change"]
		positive = change is None or change >= 0
		height = holding["weight"] if positive else -holding["weight"]
		color = muted if change is None else green if positive else red
		capped_bar(axis, index, height, color)
		weight = f'{holding["weight"]:.1f}'.rstrip("0").rstrip(".")
		direction = 1 if positive else -1
		axis.annotate(f"{weight}%", (index, height), xytext=(0, direction * 10), textcoords="offset points", ha="center", va="bottom" if positive else "top", fontsize=18, fontweight="bold")
		axis.annotate(holding["value"], (index, height), xytext=(0, direction * 32), textcoords="offset points", ha="center", va="bottom" if positive else "top", fontsize=13, color=muted)
		x_fraction = left + plot_width * (index + .65) / (len(holdings) + .30)
		figure.text(x_fraction, .165, holding["ticker"], ha="center", fontsize=14, fontweight="bold")
		figure.text(x_fraction, .12, holding["returnLabel"], ha="center", fontsize=14, fontweight="bold", color=color)
		figure.text(x_fraction, .076, holding["changeLabel"], ha="center", fontsize=13, color=color)
	axis.set_xticks([])
	figure.savefig(sys.stdout.buffer, format="png", dpi=200, facecolor=background)
	plt.close(figure)


if __name__ == "__main__":
	render(json.load(sys.stdin))
