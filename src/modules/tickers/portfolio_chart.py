import json
import math
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter


def render(chart):
	holdings = chart["holdings"]
	background = "#101820"
	foreground = "#F3F6F9"
	muted = "#95A5B6"
	green = "#57D6A0"
	red = "#FA7E86"
	plt.rcParams.update({"font.family": "DejaVu Sans", "text.color": foreground, "text.parse_math": False})
	figure = plt.figure(figsize=(max(12, len(holdings) * 1.6 + .8), 8), facecolor=background)
	figure.text(.075, .915, chart["total"], fontsize=29, fontweight="bold")
	count = chart["holdingsCount"]
	figure.text(.075, .875, f"{count} {'holding' if count == 1 else 'holdings'}", fontsize=12, color=muted)
	axis = figure.add_axes([.075, .145, .85, .655], facecolor=background)
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
	axis.tick_params(axis="y", colors="#718293", labelsize=10, length=0, pad=8)
	axis.set_axisbelow(True)
	axis.grid(axis="y", color="#24313F", linewidth=.75)
	axis.axhline(0, color="#8494A6", linewidth=1.3, zorder=2)
	for spine in axis.spines.values():
		spine.set_visible(False)
	for index, holding in enumerate(holdings):
		change = holding["change"]
		positive = change is None or change >= 0
		height = holding["weight"] if positive else -holding["weight"]
		color = muted if change is None else green if positive else red
		axis.bar(index, height, width=.55, color=color, zorder=3)
		weight_y = height + 2.1 * scale if positive else height - 3.1 * scale
		value_y = weight_y + 3.3 * scale if positive else weight_y - 3.3 * scale
		weight = f'{holding["weight"]:.1f}'.rstrip("0").rstrip(".")
		axis.text(index, weight_y, f"{weight}%", ha="center", va="center", fontsize=18, fontweight="bold")
		axis.text(index, value_y, holding["value"], ha="center", va="center", fontsize=11, color=muted)
		x_fraction = .075 + .85 * (index + .65) / (len(holdings) + .30)
		figure.text(x_fraction, .12, holding["ticker"], ha="center", fontsize=13, fontweight="bold")
		figure.text(x_fraction, .083, holding["returnLabel"], ha="center", fontsize=11, color=color)
	axis.set_xticks([])
	figure.savefig(sys.stdout.buffer, format="png", dpi=160, facecolor=background)
	plt.close(figure)


if __name__ == "__main__":
	render(json.load(sys.stdin))
