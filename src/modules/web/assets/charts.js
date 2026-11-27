// Interactive high-DPI editorial financial Canvas chart engine.
window.EyriCharts = (() => {
  const CSS = () => {
    const s = getComputedStyle(document.documentElement);
    const get = (name, fallback) => s.getPropertyValue(name).trim() || fallback;
    return {
      text: get("--text", "#f5f4f0"),
      secondary: get("--text-2", "#a09f98"),
      muted: get("--text-3", "#6c6b65"),
      line: get("--line", "rgba(255,255,255,0.09)"),
      bg: get("--bg", "#09090b"),
      green: get("--green", "#12d27a"),
      red: get("--red", "#ff4c5e"),
      accent: get("--accent", "#4d9bff"),
      amber: get("--amber", "#f5a623"),
      indigo: get("--indigo", "#8d97ff"),
      isLight: document.documentElement.getAttribute("data-theme") === "light",
    };
  };

  function setupCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    // Size the bitmap to the exact device-pixel size of the element. Rounding CSS width first
    // (or capping DPR) makes the browser resample the bitmap, which looks blurry on
    // fractional scaling (125%/150%) and 3x screens.
    const dpr = Math.min(window.devicePixelRatio || 1, 4);
    const width = Math.max(100, rect.width);
    const height = Math.max(100, rect.height);
    const pxW = Math.max(1, Math.round(width * dpr));
    const pxH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pxW || canvas.height !== pxH) {
      canvas.width = pxW;
      canvas.height = pxH;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(pxW / width, 0, 0, pxH / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return { ctx, width, height };
  }

  function niceTicks(min, max, count = 5) {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
    if (min === max) {
      const pad = Math.abs(min) * 0.05 || 1;
      return [min - pad, min, max + pad];
    }
    const span = max - min;
    const rawStep = span / Math.max(2, count);
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const nice = norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10;
    const step = nice * mag;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step * 0.001; v += step) {
      ticks.push(Number(v.toPrecision(10)));
    }
    return ticks;
  }

  function drawCallout(ctx, x, y, text, color, bg, align = "center") {
    ctx.save();
    ctx.font = "600 12.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
    const padX = 7;
    const h = 22;
    const w = ctx.measureText(text).width + padX * 2;
    let rx = x - w / 2;
    if (align === "left") rx = x;
    if (align === "right") rx = x - w;
    const ry = y - h / 2;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.roundRect(rx, ry, w, h, 5);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(text, rx + padX, y + 0.5);
    ctx.restore();
  }

  // Draws a highlighted range between two x positions with a change callout.
  function drawSelection(ctx, colors, sel) {
    const { x1, x2, y1, y2, top, bottom, label, positive } = sel;
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const tint = positive ? "rgba(18, 210, 122, 0.10)" : "rgba(255, 76, 94, 0.10)";
    const color = positive ? colors.green : colors.red;
    ctx.save();
    ctx.fillStyle = tint;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const x of [x1, x2]) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, top);
      ctx.lineTo(Math.round(x) + 0.5, bottom);
      ctx.stroke();
    }
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of [[x1, y1], [x2, y2]]) {
      ctx.fillStyle = color;
      ctx.strokeStyle = colors.bg;
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.arc(x, y, 4.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.font = "600 12.5px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
    const w = ctx.measureText(label).width + 14;
    const canvasW = ctx.canvas.getBoundingClientRect().width;
    const cx = Math.max(w / 2 + 4, Math.min(canvasW - w / 2 - 4, (left + right) / 2));
    drawCallout(ctx, cx, top + 11, label, "#fff", color);
    ctx.restore();
  }

  function signed(n, fmt) {
    if (!Number.isFinite(n)) return "—";
    return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
  }

  function attachInteractive(canvas, renderFn, onHover) {
    let hoverX = null;
    let dragStartX = null;
    const selection = () =>
      dragStartX !== null && hoverX !== null && Math.abs(hoverX - dragStartX) >= 4
        ? { from: dragStartX, to: hoverX }
        : null;
    const draw = () => {
      const sel = selection();
      renderFn(sel ? null : hoverX, sel);
      if (sel && onHover) onHover(null);
    };

    const xOf = (clientX) => clientX - canvas.getBoundingClientRect().left;
    const onMove = (e) => {
      hoverX = xOf(e.touches ? e.touches[0].clientX : e.clientX);
      draw();
    };
    const onLeave = () => {
      hoverX = null;
      if (dragStartX === null) {
        draw();
        if (onHover) onHover(null);
      }
    };
    const onDown = (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragStartX = xOf(e.clientX);
      hoverX = dragStartX;
    };
    const onWindowMove = (e) => {
      if (dragStartX === null) return;
      const rect = canvas.getBoundingClientRect();
      hoverX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      draw();
    };
    const onUp = (e) => {
      if (dragStartX === null) return;
      dragStartX = null;
      const rect = canvas.getBoundingClientRect();
      const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top &&
        e.clientY <= rect.bottom;
      hoverX = inside ? e.clientX - rect.left : null;
      draw();
      if (!inside && onHover) onHover(null);
    };

    const ro = new ResizeObserver(() => draw());
    ro.observe(canvas);
    canvas.style.cursor = "crosshair";
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("touchmove", onMove, { passive: true });
    canvas.addEventListener("touchend", onLeave);

    draw();

    return {
      redraw: draw,
      destroy() {
        ro.disconnect();
        canvas.removeEventListener("mousemove", onMove);
        canvas.removeEventListener("mouseleave", onLeave);
        canvas.removeEventListener("mousedown", onDown);
        window.removeEventListener("mousemove", onWindowMove);
        window.removeEventListener("mouseup", onUp);
        canvas.removeEventListener("touchmove", onMove);
        canvas.removeEventListener("touchend", onLeave);
      },
    };
  }

  function createPersonalChart(canvas, config) {
    const {
      points,
      mode,
      kind,
      purchaseDates = [],
      showKeyPoints = true,
      showBuys = true,
      formatY,
      onHover,
    } = config;

    const purchaseSet = new Set(purchaseDates);

    return attachInteractive(canvas, (hoverX, sel) => {
      const { ctx, width, height } = setupCanvas(canvas);
      const colors = CSS();
      if (!points || points.length < 1) return;

      const pad = { top: 28, right: 78, bottom: 32, left: 6 };
      const plotW = Math.max(40, width - pad.left - pad.right);
      const plotH = Math.max(40, height - pad.top - pad.bottom);

      const vals = points.map((p) => (mode === "pct" ? p.returnPct : p.value));
      const benchVals = points.map((p) => (mode === "pct" ? p.benchmarkReturnPct : p.benchmarkValue));

      let minY = Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < points.length; i++) {
        if (vals[i] !== null && Number.isFinite(vals[i])) {
          if (vals[i] < minY) minY = vals[i];
          if (vals[i] > maxY) maxY = vals[i];
        }
        if (benchVals[i] !== null && Number.isFinite(benchVals[i])) {
          if (benchVals[i] < minY) minY = benchVals[i];
          if (benchVals[i] > maxY) maxY = benchVals[i];
        }
      }
      if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return;

      if (kind !== "worth") {
        minY = Math.min(minY, 0);
        maxY = Math.max(maxY, 0);
      }
      const span = maxY - minY || Math.abs(maxY) * 0.1 || 1;
      minY -= span * 0.08;
      maxY += span * 0.11;

      const xFor = (i) =>
        points.length === 1
          ? pad.left + plotW / 2
          : pad.left + (i / (points.length - 1)) * plotW;
      const yFor = (v) => pad.top + ((maxY - v) / (maxY - minY)) * plotH;

      // Hairline horizontal grid & right Y axis
      const ticks = niceTicks(minY, maxY, 4);
      ctx.font = "500 12.5px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const tick of ticks) {
        const y = yFor(tick);
        if (y < pad.top - 4 || y > pad.top + plotH + 4) continue;
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, Math.round(y) + 0.5);
        ctx.lineTo(pad.left + plotW, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = colors.muted;
        ctx.fillText(formatY(tick), pad.left + plotW + 10, y);
      }

      if (kind !== "worth" && minY <= 0 && maxY >= 0) {
        const y0 = yFor(0);
        ctx.save();
        ctx.setLineDash([4, 5]);
        ctx.strokeStyle = colors.isLight ? "rgba(17,17,16,0.24)" : "rgba(255,255,255,0.22)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, y0);
        ctx.lineTo(pad.left + plotW, y0);
        ctx.stroke();
        ctx.restore();
      }

      // X-axis labels
      const xLabels = Math.min(6, points.length);
      ctx.fillStyle = colors.muted;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let k = 0; k < xLabels; k++) {
        const idx = xLabels === 1 ? 0 : Math.round((k / (xLabels - 1)) * (points.length - 1));
        const x = Math.min(Math.max(xFor(idx), pad.left + 32), pad.left + plotW - 32);
        ctx.fillText(points[idx].date, x, pad.top + plotH + 10);
      }

      const firstValid = vals.find((v) => v !== null && Number.isFinite(v));
      let lastValid = null;
      for (let i = vals.length - 1; i >= 0; i--) {
        if (vals[i] !== null && Number.isFinite(vals[i])) {
          lastValid = vals[i];
          break;
        }
      }
      const isPositive = kind === "worth"
        ? (lastValid ?? 0) >= (firstValid ?? 0)
        : (lastValid ?? 0) >= 0;
      const lineColor = isPositive ? colors.green : colors.red;

      // Benchmark dashed curve
      if (benchVals.some((v) => v !== null && Number.isFinite(v))) {
        ctx.save();
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 1.75;
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < points.length; i++) {
          const bv = benchVals[i];
          if (bv === null || !Number.isFinite(bv)) { started = false; continue; }
          const x = xFor(i);
          const y = yFor(bv);
          if (!started) { ctx.moveTo(x, y); started = true; }
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.restore();
      }

      // Subtle translucent area fill
      const baseZeroY = kind !== "worth" && minY <= 0 && maxY >= 0 ? yFor(0) : pad.top + plotH;
      const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
      grad.addColorStop(0, isPositive ? "rgba(18, 210, 122, 0.2)" : "rgba(255, 76, 94, 0.2)");
      grad.addColorStop(1, isPositive ? "rgba(18, 210, 122, 0.0)" : "rgba(255, 76, 94, 0.0)");

      ctx.save();
      ctx.beginPath();
      let segStart = -1;
      for (let i = 0; i < points.length; i++) {
        const v = vals[i];
        if (v === null || !Number.isFinite(v)) {
          if (segStart >= 0) {
            ctx.lineTo(xFor(i - 1), baseZeroY);
            ctx.lineTo(xFor(segStart), baseZeroY);
            ctx.closePath();
            segStart = -1;
          }
          continue;
        }
        if (segStart < 0) {
          segStart = i;
          ctx.moveTo(xFor(i), yFor(v));
        } else {
          ctx.lineTo(xFor(i), yFor(v));
        }
      }
      if (segStart >= 0) {
        let lastIdx = points.length - 1;
        while (lastIdx > segStart && (vals[lastIdx] === null || !Number.isFinite(vals[lastIdx]))) lastIdx--;
        ctx.lineTo(xFor(lastIdx), baseZeroY);
        ctx.lineTo(xFor(segStart), baseZeroY);
        ctx.closePath();
      }
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      // Main line
      ctx.save();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 2.25;
      ctx.lineJoin = "round";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < points.length; i++) {
        const v = vals[i];
        if (v === null || !Number.isFinite(v)) { started = false; continue; }
        const x = xFor(i);
        const y = yFor(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();

      // Purchase markers
      if (showBuys && purchaseSet.size) {
        ctx.save();
        for (let i = 0; i < points.length; i++) {
          if (!purchaseSet.has(points[i].date)) continue;
          const v = vals[i];
          if (v === null || !Number.isFinite(v)) continue;
          ctx.fillStyle = colors.bg;
          ctx.strokeStyle = colors.amber;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(xFor(i), yFor(v), 3.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }

      // Peak & Trough key points
      if (showKeyPoints && !sel && points.length > 2) {
        let hiIdx = -1;
        let loIdx = -1;
        for (let i = 0; i < points.length; i++) {
          const v = vals[i];
          if (v === null || !Number.isFinite(v)) continue;
          if (hiIdx < 0 || v > vals[hiIdx]) hiIdx = i;
          if (loIdx < 0 || v < vals[loIdx]) loIdx = i;
        }
        if (hiIdx >= 0) {
          const hx = xFor(hiIdx);
          const hy = yFor(vals[hiIdx]);
          ctx.fillStyle = colors.green;
          ctx.beginPath();
          ctx.arc(hx, hy, 4.2, 0, Math.PI * 2);
          ctx.fill();
          const align = hx < pad.left + 75 ? "left" : hx > pad.left + plotW - 75 ? "right" : "center";
          drawCallout(ctx, hx, Math.max(pad.top + 8, hy - 16), `Peak ${formatY(vals[hiIdx])}`, "#fff", colors.green, align);
        }
        if (loIdx >= 0 && loIdx !== hiIdx) {
          const lx = xFor(loIdx);
          const ly = yFor(vals[loIdx]);
          ctx.fillStyle = colors.red;
          ctx.beginPath();
          ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
          ctx.fill();
          const align = lx < pad.left + 75 ? "left" : lx > pad.left + plotW - 75 ? "right" : "center";
          drawCallout(ctx, lx, Math.min(pad.top + plotH - 12, ly + 17), `Low ${formatY(vals[loIdx])}`, "#fff", colors.red, align);
        }
      }

      // Drag selection: change between two points
      if (sel && points.length > 1) {
        const idxAt = (px) =>
          Math.max(0, Math.min(points.length - 1, Math.round(((px - pad.left) / plotW) * (points.length - 1))));
        let a = idxAt(Math.min(sel.from, sel.to));
        let b = idxAt(Math.max(sel.from, sel.to));
        while (a < b && (vals[a] === null || !Number.isFinite(vals[a]))) a++;
        while (b > a && (vals[b] === null || !Number.isFinite(vals[b]))) b--;
        if (a < b) {
          const delta = vals[b] - vals[a];
          let label = signed(delta, formatY);
          if (mode !== "pct" && kind === "worth" && vals[a] !== 0) {
            label += ` (${signed((delta / Math.abs(vals[a])) * 100, (n) => `${n.toFixed(2)}%`)})`;
          }
          label += `  ·  ${points[a].date} → ${points[b].date}`;
          drawSelection(ctx, colors, {
            x1: xFor(a),
            x2: xFor(b),
            y1: yFor(vals[a]),
            y2: yFor(vals[b]),
            top: pad.top,
            bottom: pad.top + plotH,
            label,
            positive: delta >= 0,
          });
        }
      }

      // Crosshair
      if (hoverX !== null && hoverX >= pad.left && hoverX <= pad.left + plotW) {
        const ratio = (hoverX - pad.left) / plotW;
        const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
        const x = xFor(idx);
        const v = vals[idx];
        const bv = benchVals[idx];

        ctx.save();
        ctx.strokeStyle = colors.isLight ? "rgba(17,17,16,0.28)" : "rgba(255,255,255,0.28)";
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, pad.top + plotH);
        ctx.stroke();
        ctx.restore();

        if (v !== null && Number.isFinite(v)) {
          const y = yFor(v);
          ctx.fillStyle = lineColor;
          ctx.strokeStyle = colors.bg;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(x, y, 5.2, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        if (bv !== null && Number.isFinite(bv)) {
          const by = yFor(bv);
          ctx.fillStyle = colors.accent;
          ctx.strokeStyle = colors.bg;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, by, 4.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }

        if (onHover) {
          onHover({
            index: idx,
            point: points[idx],
            x,
            y: v !== null && Number.isFinite(v) ? yFor(v) : pad.top + plotH / 2,
            width,
            height,
            isBuyDate: purchaseSet.has(points[idx].date),
          });
        }
      }
    }, onHover);
  }

  function createTickerChart(canvas, config) {
    const {
      bars,
      intraday,
      style = "area",
      previousClose = null,
      showKeyPoints = true,
      showExtended = true,
      showTrades = true,
      dividends = [],
      splits = [],
      trades = [],
      timezone = "America/New_York",
      formatPrice,
      onHover,
    } = config;

    const visibleBars = intraday && !showExtended
      ? bars.filter((b) => b.session === "regular")
      : bars;
    const activeBars = visibleBars.length ? visibleBars : bars;

    const tradeByDate = new Map();
    if (showTrades && trades.length) {
      for (const t of trades) {
        const list = tradeByDate.get(t.date) ?? [];
        list.push(t);
        tradeByDate.set(t.date, list);
      }
    }
    const divByDate = new Map(dividends.map((d) => [d.date, d]));
    const splitByDate = new Map(splits.map((s) => [s.date, s]));

    let timeFmt = null;
    try {
      timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false });
    } catch {
      timeFmt = null;
    }
    const barLabel = (b, withDate = false) => {
      if (!intraday) return b.date;
      const t = timeFmt ? timeFmt.format(new Date(b.time)) : new Date(b.time).toISOString().slice(11, 16);
      return withDate && b.date ? `${b.date.slice(5)} ${t}` : t;
    };

    return attachInteractive(canvas, (hoverX, sel) => {
      const { ctx, width, height } = setupCanvas(canvas);
      const colors = CSS();
      if (!activeBars || activeBars.length < 1) return;

      const pad = { top: 28, right: 78, bottom: 32, left: 6 };
      const plotW = Math.max(40, width - pad.left - pad.right);
      const volH = Math.min(50, Math.floor((height - pad.top - pad.bottom) * 0.16));
      const priceH = Math.max(60, height - pad.top - pad.bottom - volH - 8);
      const plotBottom = pad.top + priceH + volH + 8;

      let minP = Infinity;
      let maxP = -Infinity;
      let maxVol = 0;
      let hiIdx = 0;
      let loIdx = 0;
      for (let i = 0; i < activeBars.length; i++) {
        const b = activeBars[i];
        const hi = style === "candles" ? b.high : b.close;
        const lo = style === "candles" ? b.low : b.close;
        if (hi > maxP) { maxP = hi; hiIdx = i; }
        if (lo < minP) { minP = lo; loIdx = i; }
        if (b.volume && b.volume > maxVol) maxVol = b.volume;
      }
      if (intraday && previousClose !== null && Number.isFinite(previousClose)) {
        minP = Math.min(minP, previousClose);
        maxP = Math.max(maxP, previousClose);
      }
      if (!Number.isFinite(minP) || !Number.isFinite(maxP)) return;
      const span = maxP - minP || Math.abs(maxP) * 0.02 || 1;
      minP -= span * 0.08;
      maxP += span * 0.11;

      const xFor = (i) =>
        activeBars.length === 1
          ? pad.left + plotW / 2
          : pad.left + (i / (activeBars.length - 1)) * plotW;
      const yFor = (p) => pad.top + ((maxP - p) / (maxP - minP)) * priceH;

      // Shaded Pre / Post session bands on intraday
      if (intraday && showExtended) {
        let bandStart = -1;
        let bandType = null;
        const flushBand = (endIdx) => {
          if (bandStart < 0 || !bandType || bandType === "regular") return;
          const x1 = xFor(bandStart);
          const x2 = xFor(endIdx);
          ctx.fillStyle = bandType === "pre"
            ? (colors.isLight ? "rgba(199, 123, 6, 0.08)" : "rgba(245, 166, 35, 0.075)")
            : (colors.isLight ? "rgba(75, 85, 214, 0.08)" : "rgba(141, 151, 255, 0.08)");
          ctx.fillRect(x1, pad.top, Math.max(2, x2 - x1), plotBottom - pad.top);
        };
        for (let i = 0; i < activeBars.length; i++) {
          const s = activeBars[i].session;
          if (s !== bandType) {
            flushBand(Math.max(bandStart, i - 1));
            bandType = s;
            bandStart = i;
          }
        }
        flushBand(activeBars.length - 1);
      }

      // Grid & price labels
      const ticks = niceTicks(minP, maxP, 4);
      ctx.font = "500 12.5px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      for (const tick of ticks) {
        const y = yFor(tick);
        if (y < pad.top - 4 || y > pad.top + priceH + 4) continue;
        ctx.strokeStyle = colors.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pad.left, Math.round(y) + 0.5);
        ctx.lineTo(pad.left + plotW, Math.round(y) + 0.5);
        ctx.stroke();
        ctx.fillStyle = colors.muted;
        ctx.fillText(formatPrice(tick), pad.left + plotW + 10, y);
      }

      // Previous close reference line
      if (intraday && previousClose !== null && Number.isFinite(previousClose)) {
        const py = yFor(previousClose);
        if (py >= pad.top && py <= pad.top + priceH) {
          ctx.save();
          ctx.setLineDash([4, 5]);
          ctx.strokeStyle = colors.isLight ? "rgba(17,17,16,0.34)" : "rgba(255,255,255,0.28)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pad.left, py);
          ctx.lineTo(pad.left + plotW, py);
          ctx.stroke();
          ctx.restore();
          drawCallout(
            ctx,
            pad.left + plotW + 6,
            py,
            formatPrice(previousClose),
            colors.bg,
            colors.secondary,
            "left",
          );
        }
      }

      // Volume bars
      if (maxVol > 0) {
        const barW = Math.max(1.5, Math.min(8, (plotW / activeBars.length) * 0.65));
        for (let i = 0; i < activeBars.length; i++) {
          const b = activeBars[i];
          if (!b.volume) continue;
          const h = (b.volume / maxVol) * volH;
          const x = xFor(i) - barW / 2;
          ctx.fillStyle = b.close >= b.open ? "rgba(18, 210, 122, 0.24)" : "rgba(255, 76, 94, 0.24)";
          ctx.fillRect(x, plotBottom - h, barW, h);
        }
      }

      // X-axis labels
      const xCount = Math.min(6, activeBars.length);
      ctx.fillStyle = colors.muted;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      for (let k = 0; k < xCount; k++) {
        const idx = xCount === 1 ? 0 : Math.round((k / (xCount - 1)) * (activeBars.length - 1));
        const b = activeBars[idx];
        const x = Math.min(Math.max(xFor(idx), pad.left + 32), pad.left + plotW - 32);
        ctx.fillText(barLabel(b), x, plotBottom + 10);
      }

      const baseline = intraday && previousClose !== null ? previousClose : activeBars[0].open;
      const isUp = activeBars[activeBars.length - 1].close >= baseline;
      const mainColor = isUp ? colors.green : colors.red;

      if (style === "candles") {
        const candleW = Math.max(2, Math.min(11, (plotW / activeBars.length) * 0.68));
        for (let i = 0; i < activeBars.length; i++) {
          const b = activeBars[i];
          const x = xFor(i);
          const yO = yFor(b.open);
          const yC = yFor(b.close);
          const col = b.session === "pre"
            ? colors.amber
            : b.session === "post"
            ? colors.indigo
            : b.close >= b.open ? colors.green : colors.red;
          ctx.strokeStyle = col;
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          ctx.moveTo(x, yFor(b.high));
          ctx.lineTo(x, yFor(b.low));
          ctx.stroke();

          ctx.fillStyle = col;
          ctx.fillRect(x - candleW / 2, Math.min(yO, yC), candleW, Math.max(1.5, Math.abs(yC - yO)));
        }
      } else {
        const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + priceH);
        grad.addColorStop(0, isUp ? "rgba(18, 210, 122, 0.2)" : "rgba(255, 76, 94, 0.2)");
        grad.addColorStop(1, isUp ? "rgba(18, 210, 122, 0.0)" : "rgba(255, 76, 94, 0.0)");

        ctx.beginPath();
        ctx.moveTo(xFor(0), yFor(activeBars[0].close));
        for (let i = 1; i < activeBars.length; i++) ctx.lineTo(xFor(i), yFor(activeBars[i].close));
        ctx.lineTo(xFor(activeBars.length - 1), pad.top + priceH);
        ctx.lineTo(xFor(0), pad.top + priceH);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.lineWidth = 2.2;
        ctx.lineJoin = "round";
        for (let i = 1; i < activeBars.length; i++) {
          const prev = activeBars[i - 1];
          const curr = activeBars[i];
          ctx.strokeStyle = curr.session === "pre"
            ? colors.amber
            : curr.session === "post"
            ? colors.indigo
            : mainColor;
          ctx.beginPath();
          ctx.moveTo(xFor(i - 1), yFor(prev.close));
          ctx.lineTo(xFor(i), yFor(curr.close));
          ctx.stroke();
        }
      }

      // Key points
      if (showKeyPoints && !sel && activeBars.length > 2) {
        const hiBar = activeBars[hiIdx];
        const loBar = activeBars[loIdx];
        const hx = xFor(hiIdx);
        const hy = yFor(style === "candles" ? hiBar.high : hiBar.close);
        ctx.fillStyle = colors.green;
        ctx.beginPath();
        ctx.arc(hx, hy, 4.2, 0, Math.PI * 2);
        ctx.fill();
        const hAlign = hx < pad.left + 70 ? "left" : hx > pad.left + plotW - 70 ? "right" : "center";
        drawCallout(ctx, hx, Math.max(pad.top + 8, hy - 16), `High ${formatPrice(style === "candles" ? hiBar.high : hiBar.close)}`, "#fff", colors.green, hAlign);

        if (loIdx !== hiIdx) {
          const lx = xFor(loIdx);
          const ly = yFor(style === "candles" ? loBar.low : loBar.close);
          ctx.fillStyle = colors.red;
          ctx.beginPath();
          ctx.arc(lx, ly, 4.2, 0, Math.PI * 2);
          ctx.fill();
          const lAlign = lx < pad.left + 70 ? "left" : lx > pad.left + plotW - 70 ? "right" : "center";
          drawCallout(ctx, lx, Math.min(pad.top + priceH - 12, ly + 17), `Low ${formatPrice(style === "candles" ? loBar.low : loBar.close)}`, "#fff", colors.red, lAlign);
        }

        if (!intraday) {
          const seenDiv = new Set();
          const seenSplit = new Set();
          for (let i = 0; i < activeBars.length; i++) {
            const d = activeBars[i].date;
            if (divByDate.has(d) && !seenDiv.has(d)) {
              seenDiv.add(d);
              drawCallout(ctx, xFor(i), pad.top + priceH - 10, "Div", "#fff", colors.accent);
            }
            if (splitByDate.has(d) && !seenSplit.has(d)) {
              seenSplit.add(d);
              drawCallout(ctx, xFor(i), pad.top + 10, splitByDate.get(d).label, "#fff", colors.indigo);
            }
          }
        }
      }

      if (showTrades && tradeByDate.size) {
        const marked = new Set();
        for (let i = 0; i < activeBars.length; i++) {
          const d = activeBars[i].date;
          if (!tradeByDate.has(d) || marked.has(d)) continue;
          marked.add(d);
          const list = tradeByDate.get(d);
          const hasBuy = list.some((t) => t.side === "buy");
          ctx.fillStyle = hasBuy ? colors.amber : colors.red;
          ctx.strokeStyle = colors.bg;
          ctx.lineWidth = 2.2;
          ctx.beginPath();
          ctx.arc(xFor(i), yFor(activeBars[i].close), 5.6, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      // Drag selection: price change between two bars
      if (sel && activeBars.length > 1) {
        const idxAt = (px) =>
          Math.max(0, Math.min(activeBars.length - 1, Math.round(((px - pad.left) / plotW) * (activeBars.length - 1))));
        const a = idxAt(Math.min(sel.from, sel.to));
        const b = idxAt(Math.max(sel.from, sel.to));
        if (a < b) {
          const from = activeBars[a].close;
          const to = activeBars[b].close;
          const delta = to - from;
          const pct = from ? (delta / from) * 100 : NaN;
          const decimals = Math.abs(from) >= 1 ? 2 : 4;
          const label = `${signed(delta, (n) => n.toFixed(decimals))} (${signed(pct, (n) => `${n.toFixed(2)}%`)})  ·  ` +
            `${barLabel(activeBars[a], true)} → ${barLabel(activeBars[b], true)}`;
          drawSelection(ctx, colors, {
            x1: xFor(a),
            x2: xFor(b),
            y1: yFor(from),
            y2: yFor(to),
            top: pad.top,
            bottom: plotBottom,
            label,
            positive: delta >= 0,
          });
        }
      }

      // Crosshair
      if (hoverX !== null && hoverX >= pad.left && hoverX <= pad.left + plotW) {
        const ratio = (hoverX - pad.left) / plotW;
        const idx = Math.max(0, Math.min(activeBars.length - 1, Math.round(ratio * (activeBars.length - 1))));
        const bar = activeBars[idx];
        const x = xFor(idx);
        const y = yFor(bar.close);

        ctx.save();
        ctx.strokeStyle = colors.isLight ? "rgba(17,17,16,0.28)" : "rgba(255,255,255,0.28)";
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, pad.top);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(pad.left + plotW, y);
        ctx.stroke();
        ctx.restore();

        ctx.fillStyle = mainColor;
        ctx.strokeStyle = colors.bg;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        if (onHover) {
          onHover({
            index: idx,
            bar,
            x,
            y,
            width,
            height,
            dividend: divByDate.get(bar.date) ?? null,
            split: splitByDate.get(bar.date) ?? null,
            trades: tradeByDate.get(bar.date) ?? [],
          });
        }
      }
    }, onHover);
  }

  function sparklineSvg(values, positive) {
    if (!values || values.length < 2) {
      return '<svg class="rail-spark" viewBox="0 0 54 24"></svg>';
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * 52 + 1;
      const y = 22 - ((v - min) / span) * 20;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const stroke = positive === true ? "var(--green)" : positive === false ? "var(--red)" : "var(--text-3)";
    return `<svg class="rail-spark" viewBox="0 0 54 24" preserveAspectRatio="none"><polyline fill="none" stroke="${stroke}" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" points="${pts}"/></svg>`;
  }

  return { createPersonalChart, createTickerChart, sparklineSvg };
})();
