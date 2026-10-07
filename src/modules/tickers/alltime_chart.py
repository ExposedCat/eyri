import json
import sys
from datetime import datetime, timedelta
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.collections import LineCollection
from matplotlib.ticker import FuncFormatter

BACKGROUND = "#101820"
FOREGROUND = "#F3F6F9"
MUTED = "#B1BFCE"
GREEN = "#63D8AB"
RED = "#FA8991"
PALETTE = [GREEN, RED, "#75C7E8", "#B7A0EC", "#E7C678", "#F3F6F9"]

def money(value):
    return f'{"+" if value > 0 else "-" if value < 0 else ""}${abs(value):,.2f}'

def render(datasets):
    plt.rcParams.update({"font.family": "DejaVu Sans", "text.color": FOREGROUND, "text.parse_math": False, "text.antialiased": True, "text.hinting": "auto"})
    first = min(datetime.fromisoformat(dataset["points"][0]["date"]) for dataset in datasets)
    last_date = max(datetime.fromisoformat(dataset["points"][-1]["date"]) for dataset in datasets)
    months = (last_date.year - first.year) * 12 + last_date.month - first.month + 1
    width = max(12, min(32, months * .6 + 1.4))
    figure = plt.figure(figsize=(width, 7), dpi=200, facecolor=BACKGROUND)
    single = len(datasets) == 1
    axis = figure.add_axes([.075, .19, .90, .76], facecolor=BACKGROUND)
    for index, dataset in enumerate(datasets):
        dates = [mdates.date2num(datetime.fromisoformat(point["date"])) for point in dataset["points"]]
        values = [point["percentage"] for point in dataset["points"]]
        last = dataset["points"][-1]
        label = dataset["label"] + (f' / {dataset["bucketName"]}' if dataset.get("bucketName") else "")
        label += f'  {last["percentage"]:+.2f}%  ({money(last["gain"])})'
        color = PALETTE[index % len(PALETTE)]
        if single:
            segments = [[(dates[i], values[i]), (dates[i + 1], values[i + 1])] for i in range(len(dates)-1)]
            colors = [GREEN if (values[i] + values[i+1]) / 2 >= 0 else RED for i in range(len(values)-1)]
            axis.add_collection(LineCollection(segments, colors=colors, linewidths=2.2, capstyle="round"))
            axis.fill_between(dates, values, 0, where=[value >= 0 for value in values], color=GREEN, alpha=.10, interpolate=True)
            axis.fill_between(dates, values, 0, where=[value < 0 for value in values], color=RED, alpha=.10, interpolate=True)
            axis.plot([], [], color=GREEN if last["percentage"] >= 0 else RED, linewidth=2.2, label=label)
            color = GREEN if last["percentage"] >= 0 else RED
        else:
            axis.plot(dates, values, color=color, linewidth=2.2, solid_capstyle="round", label=label)
        axis.scatter(dates[-1], values[-1], s=20, color=color, zorder=4)
    axis.autoscale_view()
    axis.margins(y=.15)
    axis.set_xlim(first.replace(day=1), last_date + timedelta(days=3))
    axis.axhline(0, color="#8494A6", linewidth=1)
    axis.grid(axis="both", color="#24313F", linewidth=.75)
    axis.set_axisbelow(True)
    locator = mdates.MonthLocator(interval=1)
    axis.xaxis.set_major_locator(locator)
    def month_label(value, _):
        date = mdates.num2date(value)
        show_year = date.month == 1 or (date.year, date.month) == (first.year, first.month)
        return date.strftime("%b\n%Y" if show_year else "%b")
    axis.xaxis.set_major_formatter(FuncFormatter(month_label))
    axis.yaxis.set_major_formatter(FuncFormatter(lambda value, _: f'{value:g}%'))
    axis.tick_params(axis="both", colors=MUTED, labelsize=11, length=0, pad=12)
    if months > 60:
        axis.tick_params(axis="x", labelsize=8, labelrotation=90)
    for spine in axis.spines.values(): spine.set_visible(False)
    axis.legend(loc="upper left", bbox_to_anchor=(0, -.13), frameon=False, fontsize=10, labelcolor=FOREGROUND, ncol=1 if single else 2, handlelength=2.3, borderaxespad=0)
    figure.savefig(sys.stdout.buffer, format="png", dpi=200, facecolor=BACKGROUND)
    plt.close(figure)

if __name__ == "__main__": render(json.load(sys.stdin))
