(() => {
  const $ = (id) => document.getElementById(id);
  const ALLOC_PALETTE = [
    "#4d9bff", "#12d27a", "#f5a623", "#8d97ff", "#f472b6",
    "#22d3ee", "#fb923c", "#a3e635", "#2dd4bf", "#a78bfa",
  ];

  const state = {
    user: null,
    forced: false,
    botUsername: null,
    currency: "USD",
    mainView: "personal",
    panelTab: "holdings",
    brokers: [],
    brokerTimer: null,
    panelSort: "daily",
    panelFilter: "",
    overview: null,
    watchlist: [],
    snapshots: new Map(),

    personalKind: "alltime",
    personalUnit: "value",
    personalRange: "all",
    personalBenchmark: "sp500",
    personalFilter: "all",
    personalBucket: "",
    personalShowKp: true,
    personalShowBuys: true,
    personalData: null,
    personalChartHandle: null,
    portfolioSubView: "holdings",

    activeSymbol: null,
    tickerRange: "1d",
    tickerStyle: "area",
    tickerShowKp: true,
    tickerShowExt: true,
    tickerShowTrades: true,
    tickerData: null,
    tickerContext: null,
    tickerContextSymbol: null,
    tickerChartHandle: null,
    countdownTimer: null,
    refreshTimer: null,

    searchItems: [],
    searchIdx: -1,
  };

  function escapeHtml(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function formatMoney(value, currency = state.currency, digits = 2) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency === "GBX" ? "GBP" : currency,
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value);
    } catch {
      return `${value.toFixed(digits)} ${currency}`;
    }
  }

  function formatCompactMoney(value, currency = state.currency) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${value < 0 ? "-" : ""}${(abs / 1_000_000).toFixed(2)}M`;
    if (abs >= 10_000) return `${value < 0 ? "-" : ""}${(abs / 1_000).toFixed(1)}k`;
    return formatMoney(value, currency, abs >= 1000 ? 0 : 2);
  }

  function formatPrice(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    if (abs >= 1000) return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (abs >= 1) return value.toFixed(2);
    return value.toFixed(4);
  }

  function formatSignedMoney(value, currency = state.currency) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}${formatMoney(Math.abs(value), currency)}`;
  }

  function formatSignedPct(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  }

  function formatVolume(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
    return String(Math.round(v));
  }

  function formatCountdown(ms) {
    if (ms <= 0) return "now";
    const totalSec = Math.floor(ms / 1000);
    const d = Math.floor(totalSec / 86400);
    const h = Math.floor((totalSec % 86400) / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m ${String(s).padStart(2, "0")}s`;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }

  function formatClock(unixMs, tz) {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(unixMs));
    } catch {
      return new Date(unixMs).toISOString().slice(11, 16);
    }
  }

  function signClass(v) {
    if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "";
    return v > 0 ? "pos" : "neg";
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: {
        "Content-Type": "application/json",
        "X-Requested-With": "EyriWeb",
        ...(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      showLogin("Session expired. Please sign in with Telegram.");
      throw new Error("Unauthorized");
    }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function initTheme() {
    const saved = localStorage.getItem("eyri_theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  }

  function toggleTheme() {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("eyri_theme", next);
    state.personalChartHandle?.redraw();
    state.tickerChartHandle?.redraw();
  }

  function showLogin(errorMsg = null) {
    $("splash").classList.add("hidden");
    $("workspace").classList.add("hidden");
    $("login-view").classList.remove("hidden");
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    if (state.refreshTimer) clearInterval(state.refreshTimer);

    const errEl = $("login-error");
    if (errorMsg) {
      errEl.textContent = errorMsg;
      errEl.classList.remove("hidden");
    } else {
      errEl.classList.add("hidden");
    }

    const slot = $("telegram-widget-container");
    slot.innerHTML = "";
    if (state.botUsername) {
      $("telegram-setup-hint").classList.add("hidden");
      const script = document.createElement("script");
      script.async = true;
      script.src = "https://telegram.org/js/telegram-widget.js?22";
      script.setAttribute("data-telegram-login", state.botUsername);
      script.setAttribute("data-size", "large");
      script.setAttribute("data-radius", "8");
      // Redirect flow: data-onauth needs eval(), which our CSP forbids.
      script.setAttribute("data-auth-url", "/auth/telegram/callback");
      script.setAttribute("data-request-access", "write");
      slot.appendChild(script);
    } else {
      $("telegram-setup-hint").classList.remove("hidden");
    }
  }

  async function boot() {
    initTheme();
    const params = new URLSearchParams(location.search);
    const loginError = params.get("login_error");
    if (loginError !== null) history.replaceState(null, "", location.pathname + location.hash);
    try {
      const data = await fetch("/api/auth/session", { credentials: "same-origin" }).then((r) => r.json());
      state.botUsername = data.botUsername || null;
      state.forced = Boolean(data.forced);
      if (data.authenticated && data.user) {
        state.user = data.user;
        enterWorkspace();
      } else {
        showLogin(loginError);
      }
    } catch {
      showLogin("Unable to reach Eyri server.");
    }
  }

  function defaultTickerSymbol() {
    const holdings = state.overview?.holdings || [];
    const stock = holdings.find((h) => h.assetType === "stock") || holdings[0];
    if (stock) return (stock.optionMeta?.underlying || stock.yahooSymbol || stock.ticker || "").toUpperCase() || null;
    return state.watchlist[0] || null;
  }

  // ---- Broker (IB Gateway) status ----
  const BROKER_LABEL = {
    ready: "Connected",
    recovering: "Connecting",
    blocked: "Stopped",
    unavailable: "Unreachable",
    unknown: "Unknown",
  };

  async function loadBrokerStatus() {
    try {
      const data = await api("/api/brokers/status");
      state.brokers = data.brokers || [];
    } catch {
      // keep last known state
    }
    renderBrokerStatus();
    const busy = state.brokers.some((b) => b.state !== "ready" || (b.restart && !b.restart.done));
    if (state.brokerTimer) clearTimeout(state.brokerTimer);
    if (state.user) state.brokerTimer = setTimeout(loadBrokerStatus, busy ? 4_000 : 30_000);
  }

  function startBrokerStatus() {
    loadBrokerStatus();
  }

  function renderBrokerStatus() {
    const el = $("broker-status");
    if (!state.brokers.length) {
      el.classList.add("hidden");
      el.innerHTML = "";
      return;
    }
    el.classList.remove("hidden");
    const many = state.brokers.length > 1;
    el.innerHTML = state.brokers.map((b) => {
      const restarting = b.restart && !b.restart.done;
      const stateCls = restarting ? "recovering" : b.state;
      const label = restarting ? "Restarting" : (BROKER_LABEL[b.state] || b.state);
      const detail = restarting ? b.restart.message : b.message;
      const name = many ? `IBKR · ${b.host}` : "IBKR";
      return `
        <div class="broker-pill ${escapeHtml(stateCls)}" title="${escapeHtml(detail)}">
          <span class="broker-dot"></span>
          <span class="broker-name">${escapeHtml(name)}</span>
          <span class="broker-state">${escapeHtml(label)}</span>
          <button class="broker-restart" type="button" data-host="${escapeHtml(b.host)}" ${restarting ? "disabled" : ""}
            title="Restart IB Gateway (${escapeHtml(b.host)})" aria-label="Restart IB Gateway">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"/></svg>
            <span>Restart</span>
          </button>
        </div>`;
    }).join("");
    el.querySelectorAll(".broker-restart").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const host = btn.dataset.host;
        if (!confirm(`Restart IB Gateway ${host}? IBKR will log in again.`)) return;
        btn.disabled = true;
        try {
          await api("/api/brokers/restart", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ host }),
          });
        } catch (err) {
          alert(err instanceof Error ? err.message : String(err));
        }
        loadBrokerStatus();
      });
    });
  }

  function enterWorkspace() {
    $("splash").classList.add("hidden");
    $("login-view").classList.add("hidden");
    $("workspace").classList.remove("hidden");

    const name = [state.user.firstName, state.user.lastName].filter(Boolean).join(" ") ||
      (state.user.username ? `@${state.user.username}` : `User ${state.user.userId}`);
    $("user-name").textContent = state.forced ? `${name} (local)` : name;
    $("account-btn").disabled = state.forced;
    $("account-btn").title = state.forced ? "Local session" : "Sign out";
    startBrokerStatus();

    const avatar = $("user-avatar");
    if (state.user.photoUrl) {
      avatar.innerHTML = `<img src="${escapeHtml(state.user.photoUrl)}" alt="">`;
    } else {
      avatar.textContent = name.slice(0, 1).toUpperCase();
    }

    const params = new URLSearchParams(window.location.search);
    const initialTicker = params.get("ticker");
    if (initialTicker) {
      state.activeSymbol = initialTicker.toUpperCase();
      switchMainView("ticker", false);
    } else {
      switchMainView("personal", false);
    }

    refreshAll();
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = setInterval(() => {
      if (document.visibilityState === "visible") {
        refreshSnapshots();
        if (state.mainView === "ticker" && state.activeSymbol && (state.tickerRange === "1d" || state.tickerRange === "5d")) {
          loadTickerView(state.activeSymbol, { silent: true });
        }
      }
    }, 30_000);
  }

  async function refreshAll(force = false) {
    $("refresh-btn").classList.add("spinning");
    try {
      // Never block sidebar snapshots behind a cold personal chart build!
      const overviewAndSnaps = loadOverview(force).then(() => refreshSnapshots());
      const mainTask = state.mainView === "personal"
        ? loadPersonalChart(force)
        : loadTickerView(state.activeSymbol);
      await Promise.all([overviewAndSnaps, mainTask]);
    } finally {
      $("refresh-btn").classList.remove("spinning");
    }
  }

  function switchMainView(view, shouldLoad = true) {
    state.mainView = view;
    document.querySelectorAll("[data-main-view]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mainView === view);
    });
    $("personal-view").classList.toggle("hidden", view !== "personal");
    $("ticker-view").classList.toggle("hidden", view !== "ticker");

    if (shouldLoad) {
      if (view === "personal" && !state.personalData) loadPersonalChart();
      if (view === "ticker") loadTickerView(state.activeSymbol);
    }
  }

  function openTicker(symbol) {
    const cleaned = symbol.trim().toUpperCase();
    if (!cleaned) return;
    state.activeSymbol = cleaned;
    closeMobileSidebar();
    switchMainView("ticker", false);
    loadTickerView(cleaned);
    renderTickersSidebar();
  }

  async function loadOverview(force = false) {
    const q = new URLSearchParams();
    if (state.personalBucket) q.set("bucket", state.personalBucket);
    if (state.personalFilter !== "all") q.set("filter", state.personalFilter);
    if (force) q.set("refresh", "1");
    try {
      const data = await api(`/api/portfolio/overview?${q}`);
      state.overview = data;
      state.currency = data.currency || "USD";
      state.watchlist = (data.watchlist || []).map((w) => w.symbol);
      $("unit-currency-btn").textContent = state.currency;

      if (!state.panelTabChosen) {
        const tab = data.holdings?.length || !state.watchlist.length ? "holdings" : "watchlist";
        if (tab !== state.panelTab) {
          state.panelTab = tab;
          document.querySelectorAll("#sidebar-tabs .rail-tab").forEach((b) => {
            b.classList.toggle("active", b.dataset.panelTab === tab);
          });
        }
      }
      if (!state.activeSymbol) {
        state.activeSymbol = defaultTickerSymbol();
        if (state.mainView === "ticker" && state.activeSymbol) loadTickerView(state.activeSymbol);
      }

      const bucketSel = $("personal-bucket");
      if (data.buckets?.length) {
        bucketSel.classList.remove("hidden");
        const prev = state.personalBucket;
        bucketSel.innerHTML = `<option value="">Default portfolio</option>` +
          data.buckets.map((b) => `<option value="${escapeHtml(b.name)}">${escapeHtml(b.name)}</option>`).join("");
        bucketSel.value = prev;
      } else {
        bucketSel.classList.add("hidden");
      }

      const hasRsu = Boolean(data.rsu?.vestings?.length);
      $("subview-rsu-btn").classList.toggle("hidden", !hasRsu);

      const alertEl = $("personal-alert");
      if (!data.hasIntegrations) {
        alertEl.textContent = "No broker accounts connected for this user yet — switch to Markets or search any ticker above.";
        alertEl.classList.remove("hidden");
      } else if (data.errors?.length) {
        alertEl.textContent = data.errors.join(" · ");
        alertEl.classList.remove("hidden");
      } else {
        alertEl.classList.add("hidden");
      }

      renderPersonalMetrics();
      renderPortfolioSubView();
      renderTickersSidebar();
    } catch (err) {
      $("personal-alert").textContent = err instanceof Error ? err.message : String(err);
      $("personal-alert").classList.remove("hidden");
    }
  }

  function renderPersonalMetrics() {
    const s = state.overview?.summary;
    const set = (valId, subId, valText, subText, cls = "") => {
      const v = $(valId);
      v.textContent = valText;
      v.className = `m-val ${cls}`;
      $(subId).textContent = subText;
    };
    if (!s) {
      set("kpi-worth", "kpi-cash", "—", "Cash —");
      set("kpi-dpnl", "kpi-dpnl-pct", "—", "—");
      set("kpi-open", "kpi-open-pct", "—", "—");
      set("kpi-alltime", "kpi-alltime-pct", "—", "—");
      return;
    }
    set("kpi-worth", "kpi-cash", formatMoney(s.netWorth), s.cash !== null ? `Cash ${formatMoney(s.cash)}` : "No cash");
    set(
      "kpi-dpnl",
      "kpi-dpnl-pct",
      formatSignedMoney(s.dailyPnl),
      `${formatSignedPct(s.dailyPct)}${s.dailyCached ? " · cached" : ""}`,
      signClass(s.dailyPnl),
    );
    set(
      "kpi-open",
      "kpi-open-pct",
      formatSignedMoney(s.openPnl),
      `${formatSignedPct(s.openPct)}${s.openPeriod ? ` · ${s.openPeriod}` : ""}`,
      signClass(s.openPnl),
    );
    set(
      "kpi-alltime",
      "kpi-alltime-pct",
      formatSignedMoney(s.allTimePnl),
      `${formatSignedPct(s.allTimePct)}${s.contributedCapital !== null ? ` on ${formatCompactMoney(s.contributedCapital)}` : ""}`,
      signClass(s.allTimePnl),
    );
  }

  function renderPortfolioSubView() {
    const body = $("portfolio-subview-body");
    const data = state.overview;
    if (!data || !data.hasIntegrations) {
      body.innerHTML = `<div class="empty-state">No positions to display for this user.</div>`;
      return;
    }

    if (state.portfolioSubView === "holdings") {
      const rows = data.holdings || [];
      if (!rows.length) {
        body.innerHTML = `<div class="empty-state">No open positions in this view.</div>`;
        return;
      }
      body.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th class="num">Shares</th>
                <th class="num">Avg cost</th>
                <th class="num">Price</th>
                <th class="num">Value</th>
                <th class="num">Weight</th>
                <th class="num">Today</th>
                <th class="num">Total P&amp;L</th>
                <th class="num">Held</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((h) => {
                const sym = h.optionMeta?.underlying || h.yahooSymbol || h.ticker;
                const label = h.displayTicker || h.ticker;
                const exp = h.optionMeta?.expiry ? ` <span style="color:var(--text-3)">${escapeHtml(h.optionMeta.expiry)}</span>` : "";
                return `
                  <tr class="clickable" data-open-ticker="${escapeHtml(sym)}">
                    <td><strong>${escapeHtml(label)}</strong>${exp}</td>
                    <td class="num">${h.amount !== null ? h.amount.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}</td>
                    <td class="num">${formatMoney(h.averagePrice)}</td>
                    <td class="num">${formatMoney(h.currentPrice)}</td>
                    <td class="num"><strong>${formatMoney(h.value)}</strong></td>
                    <td class="num">
                      ${h.weightPct !== null ? `<span class="weight-bar"><span style="width:${Math.min(100, h.weightPct).toFixed(1)}%"></span></span>${h.weightPct.toFixed(1)}%` : "—"}
                    </td>
                    <td class="num ${signClass(h.dailyPnl)}">${formatSignedMoney(h.dailyPnl)} (${formatSignedPct(h.dailyPct)})</td>
                    <td class="num ${signClass(h.pnl)}"><strong>${formatSignedMoney(h.pnl)}</strong> (${formatSignedPct(h.returnPct)})</td>
                    <td class="num" style="color:var(--text-3)">${escapeHtml(h.period || "—")}</td>
                  </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>`;
    } else if (state.portfolioSubView === "allocation") {
      const alloc = data.allocation || [];
      if (!alloc.length) {
        body.innerHTML = `<div class="empty-state">No allocation breakdown available.</div>`;
        return;
      }
      const total = alloc.reduce((sum, a) => sum + a.value, 0);
      const radius = 84;
      const circ = 2 * Math.PI * radius;
      let offset = 0;
      const slices = alloc.map((a, idx) => {
        const len = (a.weightPct / 100) * circ;
        const color = ALLOC_PALETTE[idx % ALLOC_PALETTE.length];
        const seg = `<circle cx="110" cy="110" r="${radius}" fill="none" stroke="${color}" stroke-width="24" stroke-dasharray="${len.toFixed(2)} ${(circ - len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 110 110)" />`;
        offset += len;
        return seg;
      }).join("");

      body.innerHTML = `
        <div class="alloc-grid">
          <div class="alloc-donut-wrap">
            <svg width="220" height="220" viewBox="0 0 220 220">${slices}</svg>
            <div class="alloc-center">
              <strong>${formatCompactMoney(total)}</strong>
              <span>${alloc.length} positions</span>
            </div>
          </div>
          <div class="alloc-list">
            ${alloc.map((a, idx) => {
              const color = ALLOC_PALETTE[idx % ALLOC_PALETTE.length];
              const match = (data.holdings || []).find((h) => h.ticker === a.ticker);
              const sym = match?.yahooSymbol || a.ticker;
              return `
                <div class="alloc-row" data-open-ticker="${escapeHtml(sym)}">
                  <span class="alloc-swatch" style="background:${color}"></span>
                  <strong>${escapeHtml(a.ticker)}</strong>
                  <div class="range-bar-track"><div class="range-bar-fill" style="width:${Math.min(100, a.weightPct).toFixed(1)}%;background:${color}"></div></div>
                  <span class="num">${a.weightPct.toFixed(1)}%</span>
                  <span class="num ${signClass(a.pnl)}">${formatMoney(a.value, state.currency, 0)} · ${formatSignedPct(a.returnPct)}</span>
                </div>`;
            }).join("")}
          </div>
        </div>`;
    } else if (state.portfolioSubView === "sold") {
      const sold = data.sold || [];
      if (!sold.length) {
        body.innerHTML = `<div class="empty-state">No realized positions recorded.</div>`;
        return;
      }
      body.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr><th>Ticker</th><th class="num">Realized P&amp;L</th><th class="num">Return</th><th class="num">Held</th></tr>
            </thead>
            <tbody>
              ${sold.map((p) => `
                <tr class="clickable" data-open-ticker="${escapeHtml(p.ticker)}">
                  <td><strong>${escapeHtml(p.ticker)}</strong></td>
                  <td class="num ${signClass(p.pnl)}"><strong>${formatSignedMoney(p.pnl)}</strong></td>
                  <td class="num ${signClass(p.returnPct)}">${formatSignedPct(p.returnPct)}</td>
                  <td class="num" style="color:var(--text-3)">${escapeHtml(p.period || "—")}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
    } else if (state.portfolioSubView === "history") {
      const years = [...(data.history || [])].sort((a, b) => b.year - a.year);
      if (!years.length) {
        body.innerHTML = `<div class="empty-state">No purchase history available.</div>`;
        return;
      }
      body.innerHTML = years.map((y) => `
        <div class="history-year">
          <div class="history-year-head">
            <span>${y.year}</span>
            <span class="num">${formatMoney(y.spent)}</span>
          </div>
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>Date</th><th>Ticker</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Spent</th></tr></thead>
              <tbody>
                ${[...y.purchases].reverse().map((p) => `
                  <tr class="clickable" data-open-ticker="${escapeHtml(p.ticker)}">
                    <td style="color:var(--text-2)">${escapeHtml(p.date)}</td>
                    <td><strong>${escapeHtml(p.ticker)}</strong></td>
                    <td class="num">${p.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
                    <td class="num">${formatMoney(p.price)}</td>
                    <td class="num">${formatMoney(p.spent)}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>`).join("");
    } else if (state.portfolioSubView === "rsu") {
      const vestings = data.rsu?.vestings || [];
      if (!vestings.length) {
        body.innerHTML = `<div class="empty-state">No upcoming RSU vestings.</div>`;
        return;
      }
      body.innerHTML = `
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>Date</th><th>Ticker</th><th class="num">Units</th><th class="num">Value</th><th class="num">Change</th></tr></thead>
            <tbody>
              ${vestings.map((v) => `
                <tr class="clickable" data-open-ticker="${escapeHtml(v.ticker)}">
                  <td style="color:var(--text-2)">${escapeHtml(v.date || "—")}</td>
                  <td><strong>${escapeHtml(v.ticker)}</strong></td>
                  <td class="num">${v.amount ?? "—"}</td>
                  <td class="num">${formatMoney(v.value)}</td>
                  <td class="num ${signClass(v.change)}">${formatSignedMoney(v.change)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
    }

    body.querySelectorAll("[data-open-ticker]").forEach((el) => {
      el.addEventListener("click", () => openTicker(el.dataset.openTicker));
    });
  }

  let chartRevalidateTimer = null;
  async function loadPersonalChart(force = false, silent = false) {
    clearTimeout(chartRevalidateTimer);
    if (!silent) {
      $("personal-chart-loader").classList.remove("hidden");
      $("personal-chart-empty").classList.add("hidden");
    }
    const q = new URLSearchParams({
      kind: state.personalKind,
      benchmark: state.personalBenchmark,
    });
    if (state.personalFilter !== "all") q.set("filter", state.personalFilter);
    if (state.personalBucket) q.set("bucket", state.personalBucket);
    if (force) q.set("refresh", "1");

    try {
      const data = await api(`/api/portfolio/chart?${q}`);
      state.personalData = data;
      renderPersonalChart();
      // If server returned cached chart while refreshing in background, poll once cleanly.
      if (data.refreshing && state.mainView === "personal") {
        chartRevalidateTimer = setTimeout(() => loadPersonalChart(false, true), 5_000);
      }
    } catch (err) {
      if (!silent) {
        $("personal-chart-empty").textContent = err instanceof Error ? err.message : "Failed to load chart.";
        $("personal-chart-empty").classList.remove("hidden");
      }
    } finally {
      $("personal-chart-loader").classList.add("hidden");
    }
  }

  function filterPersonalPointsByRange(points, range) {
    if (!points.length || range === "all") return points;
    const endDate = new Date(`${points[points.length - 1].date}T00:00:00Z`);
    const cutoff = new Date(endDate);
    if (range === "1m") cutoff.setUTCMonth(cutoff.getUTCMonth() - 1);
    else if (range === "3m") cutoff.setUTCMonth(cutoff.getUTCMonth() - 3);
    else if (range === "6m") cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
    else if (range === "ytd") cutoff.setUTCMonth(0, 1);
    else if (range === "1y") cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const sliced = points.filter((p) => p.date >= cutoffStr);
    return sliced.length >= 2 ? sliced : points;
  }

  function renderPersonalChart() {
    const data = state.personalData;
    if (state.personalChartHandle) {
      state.personalChartHandle.destroy();
      state.personalChartHandle = null;
    }

    const pctBtn = document.querySelector('#personal-unit-group [data-unit="pct"]');
    if (pctBtn) {
      const hasPct = Boolean(data?.points?.some((p) => p.returnPct !== null));
      pctBtn.disabled = state.personalKind === "worth" || !hasPct;
      if (pctBtn.disabled && state.personalUnit === "pct") {
        state.personalUnit = "value";
        document.querySelectorAll("#personal-unit-group .sw-btn").forEach((b) =>
          b.classList.toggle("active", b.dataset.unit === "value")
        );
      }
    }

    if (!data || !data.points?.length) {
      $("personal-chart-empty").classList.remove("hidden");
      $("personal-hero-value").textContent = "—";
      $("personal-hero-delta").textContent = "—";
      $("personal-keypoints-strip").innerHTML = "";
      return;
    }
    $("personal-chart-empty").classList.add("hidden");

    const points = filterPersonalPointsByRange(data.points, state.personalRange);
    const mode = state.personalUnit;
    const last = points[points.length - 1];
    const first = points[0];

    const updateReadout = (pt, hover = false) => {
      const rangeSuffix = data.refreshing ? " · updating…" : "";
      $("personal-hover-date").textContent = hover ? pt.date : `${first.date} – ${last.date}${rangeSuffix}`;
      const mainVal = mode === "pct" ? pt.returnPct : pt.value;
      $("personal-hero-value").textContent = mode === "pct"
        ? formatSignedPct(mainVal)
        : (state.personalKind === "worth" ? formatMoney(mainVal, data.currency) : formatSignedMoney(mainVal, data.currency));

      const deltaEl = $("personal-hero-delta");
      if (state.personalKind === "worth") {
        const diff = pt.value !== null && first.value !== null ? pt.value - first.value : null;
        const diffPct = diff !== null && first.value ? (diff / first.value) * 100 : null;
        deltaEl.textContent = `${formatSignedMoney(diff, data.currency)} (${formatSignedPct(diffPct)})`;
        deltaEl.className = `hero-delta ${signClass(diff)}`;
      } else if (mode === "pct") {
        deltaEl.textContent = formatSignedMoney(pt.value, data.currency);
        deltaEl.className = `hero-delta ${signClass(pt.value)}`;
      } else {
        deltaEl.textContent = pt.returnPct !== null ? formatSignedPct(pt.returnPct) : `${points.length} days`;
        deltaEl.className = `hero-delta ${signClass(pt.returnPct ?? pt.value)}`;
      }

      const bEl = $("personal-bench-readout");
      const bVal = mode === "pct" ? pt.benchmarkReturnPct : pt.benchmarkValue;
      if (data.hasBenchmark && bVal !== null) {
        bEl.classList.remove("hidden");
        const formatted = mode === "pct"
          ? formatSignedPct(bVal)
          : (state.personalKind === "worth" ? formatMoney(bVal, data.currency) : formatSignedMoney(bVal, data.currency));
        bEl.textContent = `${data.benchmarkLabel || "Benchmark"} ${formatted}`;
      } else {
        bEl.classList.add("hidden");
      }
    };
    updateReadout(last, false);

    const kp = data.keyPoints;
    if (kp?.peakValue) {
      $("kpi-peak").textContent = state.personalKind === "worth"
        ? formatMoney(kp.peakValue.value, data.currency)
        : formatSignedMoney(kp.peakValue.value, data.currency);
      $("kpi-peak").className = "m-val";
      $("kpi-dd").textContent = kp.maxDrawdown
        ? `Max drawdown ${kp.maxDrawdown.pct.toFixed(1)}%`
        : `Peak ${kp.peakValue.date}`;
    }

    const items = [];
    if (kp?.peakValue) {
      items.push({
        label: "Peak",
        val: state.personalKind === "worth" ? formatMoney(kp.peakValue.value, data.currency) : formatSignedMoney(kp.peakValue.value, data.currency),
        date: kp.peakValue.date,
        cls: "pos",
      });
    }
    if (kp?.troughValue) {
      items.push({
        label: "Low",
        val: state.personalKind === "worth" ? formatMoney(kp.troughValue.value, data.currency) : formatSignedMoney(kp.troughValue.value, data.currency),
        date: kp.troughValue.date,
        cls: state.personalKind === "worth" ? "" : signClass(kp.troughValue.value),
      });
    }
    if (kp?.maxDrawdown) {
      items.push({ label: "Max drawdown", val: `${kp.maxDrawdown.pct.toFixed(2)}%`, date: kp.maxDrawdown.troughDate, cls: "neg" });
    }
    if (kp?.bestDay) {
      items.push({ label: "Best day", val: formatSignedMoney(kp.bestDay.delta, data.currency), date: kp.bestDay.date, cls: "pos" });
    }
    if (kp?.worstDay) {
      items.push({ label: "Worst day", val: formatSignedMoney(kp.worstDay.delta, data.currency), date: kp.worstDay.date, cls: "neg" });
    }
    $("personal-keypoints-strip").innerHTML = items.map((p) => `
      <span class="kp-item">
        <span>${escapeHtml(p.label)}</span>
        <strong class="${p.cls}">${escapeHtml(p.val)}</strong>
        <small>${escapeHtml(p.date)}</small>
      </span>`).join("");

    const notesEl = $("personal-chart-notes");
    if (data.notes?.length) {
      notesEl.textContent = data.notes.join(" · ");
      notesEl.classList.remove("hidden");
    } else {
      notesEl.classList.add("hidden");
    }

    const tooltip = $("personal-chart-tooltip");
    state.personalChartHandle = window.EyriCharts.createPersonalChart($("personal-chart-canvas"), {
      points,
      mode,
      kind: state.personalKind,
      purchaseDates: data.purchaseDates || [],
      showKeyPoints: state.personalShowKp,
      showBuys: state.personalShowBuys,
      formatY: (v) => mode === "pct" ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}%` : formatCompactMoney(v, data.currency),
      onHover: (info) => {
        if (!info) {
          tooltip.classList.add("hidden");
          updateReadout(last, false);
          return;
        }
        updateReadout(info.point, true);
        const p = info.point;
        const rows = [
          `<div class="tt-date"><span>${escapeHtml(p.date)}</span>${info.isBuyDate ? '<span style="color:var(--amber)">Buy day</span>' : ""}</div>`,
          `<div class="tt-row"><span>${state.personalKind === "worth" ? "Net worth" : "P&amp;L"}</span><strong class="${state.personalKind === "worth" ? "" : signClass(p.value)}">${state.personalKind === "worth" ? formatMoney(p.value, data.currency) : formatSignedMoney(p.value, data.currency)}</strong></div>`,
        ];
        if (p.returnPct !== null) {
          rows.push(`<div class="tt-row"><span>Return</span><strong class="${signClass(p.returnPct)}">${formatSignedPct(p.returnPct)}</strong></div>`);
        }
        if (data.hasBenchmark && (p.benchmarkValue !== null || p.benchmarkReturnPct !== null)) {
          const bText = mode === "pct"
            ? formatSignedPct(p.benchmarkReturnPct)
            : (state.personalKind === "worth" ? formatMoney(p.benchmarkValue, data.currency) : formatSignedMoney(p.benchmarkValue, data.currency));
          rows.push(`<div class="tt-row"><span>${escapeHtml(data.benchmarkLabel || "Benchmark")}</span><strong style="color:var(--accent)">${bText}</strong></div>`);
        }
        tooltip.innerHTML = rows.join("");
        tooltip.classList.remove("hidden");
        const left = info.x > info.width * 0.62 ? info.x - tooltip.offsetWidth - 16 : info.x + 16;
        const top = Math.max(10, Math.min(info.height - tooltip.offsetHeight - 10, info.y - 24));
        tooltip.style.left = `${Math.max(8, left)}px`;
        tooltip.style.top = `${top}px`;
      },
    });
  }

  function getPanelSymbols() {
    const holdingSymbols = (state.overview?.holdings || [])
      .map((h) => h.optionMeta?.underlying || h.yahooSymbol || h.ticker);
    return [...new Set([...holdingSymbols, ...state.watchlist])];
  }

  function formatShortExpiry(isoDate) {
    if (!isoDate) return "";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const [y, m] = isoDate.split("-");
    const mName = months[Number(m) - 1];
    return mName && y ? `${mName} '${y.slice(2)}` : isoDate;
  }

  async function refreshSnapshots() {
    const symbols = getPanelSymbols();
    if (!symbols.length) {
      renderTickersSidebar();
      return;
    }
    try {
      const data = await api(`/api/tickers/snapshots?symbols=${encodeURIComponent(symbols.join(","))}`);
      for (const snap of data.snapshots || []) {
        state.snapshots.set(snap.symbol.toUpperCase(), snap);
      }
      renderTickersSidebar();
    } catch {
      // Keep prior snapshots
    }
  }

  function renderTickersSidebar() {
    const listEl = $("tickers-list");
    const holdings = state.overview?.holdings || [];
    const holdingMap = new Map();
    for (const h of holdings) {
      const sym = (h.yahooSymbol || h.ticker).toUpperCase();
      holdingMap.set(sym, h);
    }
    const watchSet = new Set(state.watchlist.map((s) => s.toUpperCase()));
    const allSyms = new Set([...holdingMap.keys(), ...watchSet]);

    let items = [...allSyms].map((sym) => {
      const holding = holdingMap.get(sym) || null;
      const snapKey = (holding?.optionMeta?.underlying || sym).toUpperCase();
      const snap = state.snapshots.get(sym) || state.snapshots.get(snapKey) || null;
      const isWatch = watchSet.has(sym);
      const isOption = holding?.assetType === "option";
      const changePct = isOption ? (holding?.dailyPct ?? null) : (snap?.changePct ?? holding?.dailyPct ?? null);
      const price = isOption ? (holding?.currentPrice ?? null) : (snap?.price ?? holding?.currentPrice ?? null);
      const marketState = snap?.marketStatus?.state || "UNKNOWN";
      const clickSym = holding?.optionMeta?.underlying || sym;
      return {
        symbol: sym,
        clickSym,
        displayTicker: holding?.displayTicker || snap?.symbol || sym,
        name: snap?.name || sym,
        holding,
        isOption,
        isWatch,
        price,
        changePct,
        marketState,
        sparkline: snap?.sparkline || [],
        value: holding?.value ?? 0,
      };
    });

    if (state.panelTab === "holdings") items = items.filter((i) => Boolean(i.holding));
    else if (state.panelTab === "watchlist") items = items.filter((i) => i.isWatch);

    const q = state.panelFilter.trim().toUpperCase();
    if (q) {
      items = items.filter((i) =>
        i.symbol.includes(q) || i.displayTicker.toUpperCase().includes(q) || i.name.toUpperCase().includes(q)
      );
    }

    if (state.panelSort === "daily") {
      items.sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity));
    } else if (state.panelSort === "value") {
      items.sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || a.symbol.localeCompare(b.symbol));
    } else {
      items.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    if (!items.length) {
      const emptyMsg = q
        ? "No matching tickers."
        : state.panelTab === "watchlist"
        ? "Watchlist is empty. Add a symbol above."
        : state.overview?.errors?.length
        ? "Holdings unavailable while your broker reconnects."
        : "No holdings.";
      listEl.innerHTML = `<div class="empty-state">${escapeHtml(emptyMsg)}</div>`;
      return;
    }

    listEl.innerHTML = items.map((item) => {
      const isActive = state.mainView === "ticker" && state.activeSymbol.toUpperCase() === item.clickSym.toUpperCase();
      const chgCls = signClass(item.changePct);
      const positive = item.changePct === null ? null : item.changePct >= 0;
      const spark = window.EyriCharts.sparklineSvg(item.sparkline, positive);
      const subText = item.isOption
        ? `${formatShortExpiry(item.holding?.optionMeta?.expiry)} · ${formatCompactMoney(item.holding?.value)}`
        : item.holding
        ? `${formatCompactMoney(item.holding.value)} · ${item.holding.dailyPnl !== null ? formatSignedMoney(item.holding.dailyPnl) : item.name}`
        : item.name;

      return `
        <button class="ticker-row ${isActive ? "active" : ""}" data-sym="${escapeHtml(item.clickSym)}">
          <div class="rail-left">
            <div class="rail-sym-line">
              <span class="session-dot ${item.marketState}" title="${escapeHtml(item.marketState)}"></span>
              <span class="rail-sym">${escapeHtml(item.displayTicker)}</span>
            </div>
            <div class="rail-sub">${escapeHtml(subText)}</div>
          </div>
          ${spark}
          <div class="rail-right">
            <span class="rail-price">${formatPrice(item.price)}</span>
            <span class="rail-chg ${chgCls}">${formatSignedPct(item.changePct)}</span>
          </div>
        </button>`;
    }).join("");

    listEl.querySelectorAll(".ticker-row").forEach((btn) => {
      btn.addEventListener("click", () => openTicker(btn.dataset.sym));
    });
  }

  async function loadTickerView(symbol, opts = {}) {
    if (!symbol) {
      if (state.overview && !opts.silent) {
        $("ticker-alert").textContent = "Search any ticker above, or add one to your watchlist.";
        $("ticker-alert").classList.remove("hidden");
      }
      return;
    }
    if (!opts.silent) {
      $("ticker-chart-loader").classList.remove("hidden");
      $("ticker-alert").classList.add("hidden");
    }
    const symbolKey = symbol.toUpperCase();
    const symbolChanged = state.tickerContextSymbol !== symbolKey;
    if (symbolChanged) {
      // Position context comes from the (slow) broker portfolio; load it alongside, never block the chart on it.
      state.tickerContext = null;
      state.tickerContextSymbol = symbolKey;
    }
    if (symbolChanged || opts.silent) {
      api(`/api/ticker/${encodeURIComponent(symbol)}/context`)
        .then((ctx) => {
          if (state.tickerContextSymbol !== symbolKey) return;
          state.tickerContext = ctx.userContext || null;
          if (state.tickerData) renderTickerView();
        })
        .catch(() => {});
    }
    const range = state.tickerRange;
    try {
      const data = await api(
        `/api/ticker/${encodeURIComponent(symbol)}/chart?range=${encodeURIComponent(range)}&context=0`,
      );
      // Ignore stale responses after the user switched symbol or range.
      if (state.tickerContextSymbol !== symbolKey || state.tickerRange !== range) return;
      state.tickerData = data.chart;
      state.activeSymbol = data.chart.symbol;
      renderTickerView();
    } catch (err) {
      $("ticker-alert").textContent = err instanceof Error ? err.message : String(err);
      $("ticker-alert").classList.remove("hidden");
    } finally {
      $("ticker-chart-loader").classList.add("hidden");
    }
  }

  function updateMarketCountdown() {
    const ms = state.tickerData?.marketStatus;
    if (!ms) return;
    const now = Date.now();
    if (ms.state === "OPEN_24_7") {
      $("market-state-detail").textContent = ms.detail;
      $("market-state-next").textContent = "";
      return;
    }
    if (ms.nextTransitionAt && ms.nextTransitionAt > now) {
      const verb = ms.state === "REGULAR"
        ? "Closes in"
        : ms.state === "PRE"
        ? "Regular opens in"
        : ms.state === "POST"
        ? "After-hours ends in"
        : "Opens in";
      $("market-state-detail").textContent = `${verb} ${formatCountdown(ms.nextTransitionAt - now)}`;
      $("market-state-next").textContent = ms.nextTransitionLabel || "";
    } else {
      $("market-state-detail").textContent = ms.detail;
      $("market-state-next").textContent = ms.nextTransitionLabel || "";
    }
  }

  function renderSessionRibbon(ms) {
    $("schedule-tz").textContent = `${ms.timezoneShort} · ${ms.timezone}`;
    const body = $("market-schedule-body");
    if (ms.state === "OPEN_24_7") {
      body.innerHTML = `<div class="ribbon-track"><div class="ribbon-seg regular active" style="width:100%"></div></div><div class="ribbon-col-time">Trades continuously 24/7</div>`;
      return;
    }

    const sched = ms.schedule || {};
    const windows = [
      sched.pre ? { key: "PRE", name: "Pre-market", cls: "pre", ...sched.pre } : null,
      sched.regular ? { key: "REGULAR", name: "Regular session", cls: "regular", ...sched.regular } : null,
      sched.post ? { key: "POST", name: "After-hours", cls: "post", ...sched.post } : null,
    ].filter(Boolean);

    if (!windows.length) {
      body.innerHTML = `<div class="ribbon-col-local">Exchange session hours not reported.</div>`;
      return;
    }

    const minStart = Math.min(...windows.map((w) => w.start));
    const maxEnd = Math.max(...windows.map((w) => w.end));
    const total = Math.max(1, maxEnd - minStart);
    const now = Date.now();
    const showNow = now >= minStart && now <= maxEnd;
    const nowPct = ((now - minStart) / total) * 100;
    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const segs = windows.map((w) => {
      const widthPct = ((w.end - w.start) / total) * 100;
      return `<div class="ribbon-seg ${w.cls} ${ms.state === w.key ? "active" : ""}" style="width:${widthPct.toFixed(2)}%"></div>`;
    }).join("");

    const cols = windows.map((w) => {
      const isNow = ms.state === w.key;
      const exch = `${formatClock(w.start, ms.timezone)} – ${formatClock(w.end, ms.timezone)} ${ms.timezoneShort}`;
      const local = localTz !== ms.timezone
        ? `Local ${formatClock(w.start, localTz)} – ${formatClock(w.end, localTz)}`
        : "Your timezone";
      return `
        <div class="ribbon-col ${isNow ? "is-now" : ""}">
          <span class="ribbon-col-title">
            <span class="session-dot ${w.key}"></span>
            ${w.name}${isNow ? " · live" : ""}
          </span>
          <span class="ribbon-col-time">${escapeHtml(exch)}</span>
          <span class="ribbon-col-local">${escapeHtml(local)}</span>
        </div>`;
    }).join("");

    body.innerHTML = `
      <div class="ribbon-track">
        ${segs}
        ${showNow ? `<span class="ribbon-now" style="left:${nowPct.toFixed(2)}%"></span>` : ""}
      </div>
      <div class="ribbon-cols">${cols}</div>`;
  }

  function renderTickerView() {
    const c = state.tickerData;
    if (!c) return;
    const ctx = state.tickerContext;

    $("ticker-symbol").textContent = c.symbol;
    $("ticker-name").textContent = c.name;
    $("ticker-exchange").textContent = [c.exchange, c.instrumentType].filter(Boolean).join(" · ");

    const isWatched = state.watchlist.includes(c.symbol.toUpperCase());
    $("ticker-watch-btn").classList.toggle("active", isWatched);

    const ms = c.marketStatus;
    $("market-state-pill").className = `pulse-head ${ms.state}`;
    $("market-state-label").textContent = ms.label;
    updateMarketCountdown();
    if (state.countdownTimer) clearInterval(state.countdownTimer);
    state.countdownTimer = setInterval(updateMarketCountdown, 1000);

    const renderPriceHeader = (priceVal, chgVal, chgPctVal, hoverText = "") => {
      $("ticker-price").textContent = formatPrice(priceVal);
      $("ticker-currency").textContent = c.currency;
      const badge = $("ticker-change-badge");
      badge.textContent = `${chgVal !== null ? (chgVal >= 0 ? "+" : "") + formatPrice(chgVal) : "—"} (${formatSignedPct(chgPctVal)})`;
      badge.className = `hero-delta ${signClass(chgVal)}`;
      $("ticker-hover-info").textContent = hoverText;
    };
    renderPriceHeader(c.regularPrice, c.regularChange, c.regularChangePct, "");

    const extEl = $("ticker-extended-pill");
    if (c.extended) {
      extEl.classList.remove("hidden");
      extEl.className = `hero-extended ${c.extended.session}`;
      const label = c.extended.session === "pre" ? "Pre-market" : "After-hours";
      extEl.innerHTML = `
        <span class="ext-dot"></span>
        <span>${label}</span>
        <strong>${formatPrice(c.extended.price)}</strong>
        <span class="${signClass(c.extended.change)}">${formatSignedPct(c.extended.changePct)}</span>`;
    } else {
      extEl.classList.add("hidden");
    }

    $("ticker-toggle-ext").classList.toggle("hidden", !c.intraday);
    $("ticker-toggle-trades").classList.toggle("hidden", !ctx?.trades?.length);

    if (state.tickerChartHandle) {
      state.tickerChartHandle.destroy();
      state.tickerChartHandle = null;
    }
    if (!c.bars?.length) {
      $("ticker-chart-empty").classList.remove("hidden");
    } else {
      $("ticker-chart-empty").classList.add("hidden");
      const tooltip = $("ticker-chart-tooltip");
      const baseRef = c.intraday && c.previousClose !== null ? c.previousClose : c.bars[0].open;
      state.tickerChartHandle = window.EyriCharts.createTickerChart($("ticker-chart-canvas"), {
        bars: c.bars,
        intraday: c.intraday,
        style: state.tickerStyle,
        previousClose: c.previousClose,
        showKeyPoints: state.tickerShowKp,
        showExtended: state.tickerShowExt,
        showTrades: state.tickerShowTrades,
        dividends: c.dividends || [],
        splits: c.splits || [],
        trades: ctx?.trades || [],
        timezone: c.timezone,
        formatPrice,
        onHover: (info) => {
          if (!info) {
            tooltip.classList.add("hidden");
            renderPriceHeader(c.regularPrice, c.regularChange, c.regularChangePct, "");
            return;
          }
          const b = info.bar;
          const delta = baseRef ? b.close - baseRef : null;
          const deltaPct = baseRef ? (delta / baseRef) * 100 : null;
          const timeLabel = c.intraday
            ? `${b.date} ${formatClock(b.time, c.timezone)} ${ms.timezoneShort}`
            : b.date;
          renderPriceHeader(b.close, delta, deltaPct, timeLabel);

          const sessionTag = c.intraday && b.session !== "regular"
            ? `<span style="color:${b.session === "pre" ? "var(--amber)" : "var(--indigo)"}">${b.session === "pre" ? "Pre-market" : "After-hours"}</span>`
            : "";
          const lines = [
            `<div class="tt-date"><span>${escapeHtml(timeLabel)}</span>${sessionTag}</div>`,
            `<div class="tt-row"><span>Open</span><strong>${formatPrice(b.open)}</strong></div>`,
            `<div class="tt-row"><span>High</span><strong class="pos">${formatPrice(b.high)}</strong></div>`,
            `<div class="tt-row"><span>Low</span><strong class="neg">${formatPrice(b.low)}</strong></div>`,
            `<div class="tt-row"><span>Close</span><strong>${formatPrice(b.close)}</strong></div>`,
          ];
          if (b.volume !== null) lines.push(`<div class="tt-row"><span>Volume</span><strong>${formatVolume(b.volume)}</strong></div>`);
          if (info.dividend) lines.push(`<div class="tt-row"><span style="color:var(--accent)">Dividend</span><strong>${formatPrice(info.dividend.amount)}</strong></div>`);
          if (info.split) lines.push(`<div class="tt-row"><span style="color:var(--indigo)">Split</span><strong>${escapeHtml(info.split.label)}</strong></div>`);
          if (info.trades?.length) {
            for (const t of info.trades) {
              lines.push(`<div class="tt-row"><span style="color:var(--amber)">Your ${t.side}</span><strong>${t.quantity} @ ${formatPrice(t.price)}</strong></div>`);
            }
          }
          tooltip.innerHTML = lines.join("");
          tooltip.classList.remove("hidden");
          const left = info.x > info.width * 0.62 ? info.x - tooltip.offsetWidth - 16 : info.x + 16;
          const top = Math.max(10, Math.min(info.height - tooltip.offsetHeight - 10, info.y - 24));
          tooltip.style.left = `${Math.max(8, left)}px`;
          tooltip.style.top = `${top}px`;
        },
      });
    }

    const legend = [];
    if (c.intraday && state.tickerShowExt) {
      legend.push(`<span class="legend-item"><span class="legend-dot" style="background:var(--amber)"></span>Pre-market</span>`);
      legend.push(`<span class="legend-item"><span class="legend-dot" style="background:var(--green)"></span>Regular</span>`);
      legend.push(`<span class="legend-item"><span class="legend-dot" style="background:var(--indigo)"></span>After-hours</span>`);
    }
    if (c.dividends?.length) legend.push(`<span class="legend-item"><span class="legend-dot" style="background:var(--accent)"></span>Dividends (${c.dividends.length})</span>`);
    if (c.splits?.length) legend.push(`<span class="legend-item"><span class="legend-dot" style="background:var(--indigo)"></span>Splits (${c.splits.length})</span>`);
    if (ctx?.trades?.length) legend.push(`<span class="legend-item"><span class="legend-dot" style="background:var(--amber)"></span>Your trades (${ctx.trades.length})</span>`);
    $("ticker-session-legend").innerHTML = legend.join("");

    renderSessionRibbon(ms);

    const st = c.stats;
    $("ticker-period-badge").textContent = `${c.range.toUpperCase()} · ${formatSignedPct(st.periodChangePct)}`;
    const rangeBarHtml = (lo, hi, cur) => {
      if (lo === null || hi === null || cur === null || hi <= lo) return `<span class="spec-v">${formatPrice(lo)} – ${formatPrice(hi)}</span>`;
      const pct = Math.max(0, Math.min(100, ((cur - lo) / (hi - lo)) * 100));
      return `
        <div class="range-bar-track">
          <div class="range-bar-fill" style="width:${pct.toFixed(1)}%"></div>
          <div class="range-bar-thumb" style="left:${pct.toFixed(1)}%"></div>
        </div>
        <div class="range-bar-ends"><span>${formatPrice(lo)}</span><span>${formatPrice(hi)}</span></div>`;
    };
    $("ticker-stats-grid").innerHTML = `
      <div class="spec-row"><span class="spec-k">Open</span><span class="spec-v">${formatPrice(st.open)}</span></div>
      <div class="spec-row"><span class="spec-k">Previous close</span><span class="spec-v">${formatPrice(c.previousClose)}</span></div>
      <div class="spec-row"><span class="spec-k">Period high</span><span class="spec-v pos">${st.periodHigh ? `${formatPrice(st.periodHigh.price)} · ${st.periodHigh.date}` : "—"}</span></div>
      <div class="spec-row"><span class="spec-k">Period low</span><span class="spec-v neg">${st.periodLow ? `${formatPrice(st.periodLow.price)} · ${st.periodLow.date}` : "—"}</span></div>
      <div class="spec-row"><span class="spec-k">Volume</span><span class="spec-v">${formatVolume(st.volume)}</span></div>
      <div class="spec-row stacked"><span class="spec-k">Day range</span>${rangeBarHtml(st.dayLow, st.dayHigh, c.regularPrice)}</div>
      <div class="spec-row stacked"><span class="spec-k">52-week range</span>${rangeBarHtml(st.fiftyTwoWeekLow, st.fiftyTwoWeekHigh, c.regularPrice)}</div>`;

    const posCard = $("ticker-position-card");
    if (ctx?.position) {
      const p = ctx.position;
      posCard.classList.remove("hidden");
      $("position-period").textContent = p.period ? `Held ${p.period}` : "";
      $("ticker-position-body").innerHTML = `
        <div class="spec-row"><span class="spec-k">Shares</span><span class="spec-v">${p.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })}</span></div>
        <div class="spec-row"><span class="spec-k">Average cost</span><span class="spec-v">${formatMoney(p.averagePrice, ctx.currency)}</span></div>
        <div class="spec-row"><span class="spec-k">Market value</span><span class="spec-v">${formatMoney(p.value, ctx.currency)}</span></div>
        <div class="spec-row"><span class="spec-k">Cost basis</span><span class="spec-v">${formatMoney(p.cost, ctx.currency)}</span></div>
        <div class="spec-row"><span class="spec-k">Unrealized P&amp;L</span><span class="spec-v ${signClass(p.pnl)}">${formatSignedMoney(p.pnl, ctx.currency)} (${formatSignedPct(p.returnPct)})</span></div>
        <div class="spec-row"><span class="spec-k">Today's P&amp;L</span><span class="spec-v ${signClass(p.dailyPnl)}">${formatSignedMoney(p.dailyPnl, ctx.currency)} (${formatSignedPct(p.dailyPct)})</span></div>`;
    } else {
      posCard.classList.add("hidden");
    }
  }

  async function toggleWatchlist(symbol) {
    const sym = symbol.trim().toUpperCase();
    if (!sym) return;
    const isWatched = state.watchlist.includes(sym);
    try {
      if (isWatched) {
        const res = await api(`/api/watchlist/${encodeURIComponent(sym)}`, { method: "DELETE" });
        state.watchlist = (res.watchlist || []).map((w) => w.symbol);
      } else {
        const res = await api("/api/watchlist", { method: "POST", body: JSON.stringify({ symbol: sym }) });
        state.watchlist = (res.watchlist || []).map((w) => w.symbol);
      }
      renderTickerView();
      renderTickersSidebar();
      await refreshSnapshots();
    } catch (err) {
      $("ticker-alert").textContent = err instanceof Error ? err.message : String(err);
      $("ticker-alert").classList.remove("hidden");
    }
  }

  let searchDebounce = null;
  function closeSearch() {
    $("search-results").classList.add("hidden");
    state.searchItems = [];
    state.searchIdx = -1;
  }

  function renderSearchDropdown() {
    const box = $("search-results");
    if (!state.searchItems.length) {
      box.classList.add("hidden");
      return;
    }
    box.classList.remove("hidden");
    box.innerHTML = state.searchItems.map((item, idx) => `
      <button class="search-item ${idx === state.searchIdx ? "selected" : ""}" data-search-idx="${idx}">
        <div class="search-item-left">
          <div class="search-item-sym">${escapeHtml(item.symbol)}</div>
          <div class="search-item-name">${escapeHtml(item.name)}</div>
        </div>
        <span class="search-item-meta">${escapeHtml([item.exchange, item.quoteType].filter(Boolean).join(" · "))}</span>
      </button>`).join("");
    box.querySelectorAll(".search-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const item = state.searchItems[Number(el.dataset.searchIdx)];
        if (item) {
          $("global-search").value = "";
          closeSearch();
          openTicker(item.symbol);
        }
      });
    });
  }

  function bindSearch() {
    const input = $("global-search");
    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(searchDebounce);
      if (!q) { closeSearch(); return; }
      searchDebounce = setTimeout(async () => {
        try {
          const data = await api(`/api/tickers/search?q=${encodeURIComponent(q)}`);
          state.searchItems = data.results || [];
          state.searchIdx = state.searchItems.length ? 0 : -1;
          renderSearchDropdown();
        } catch {
          closeSearch();
        }
      }, 180);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (state.searchItems.length) {
          state.searchIdx = (state.searchIdx + 1) % state.searchItems.length;
          renderSearchDropdown();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (state.searchItems.length) {
          state.searchIdx = (state.searchIdx - 1 + state.searchItems.length) % state.searchItems.length;
          renderSearchDropdown();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const picked = state.searchItems[state.searchIdx]?.symbol || input.value.trim();
        if (picked) {
          input.value = "";
          closeSearch();
          openTicker(picked);
        }
      } else if (e.key === "Escape") {
        closeSearch();
        input.blur();
      }
    });

    input.addEventListener("blur", () => setTimeout(closeSearch, 150));

    window.addEventListener("keydown", (e) => {
      if ((e.key === "/" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) &&
        document.activeElement?.tagName !== "INPUT" &&
        document.activeElement?.tagName !== "TEXTAREA") {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  function closeMobileSidebar() {
    $("tickers-sidebar").classList.remove("open");
    $("sidebar-scrim").classList.add("hidden");
  }

  function bindEvents() {
    bindSearch();
    $("theme-toggle").addEventListener("click", toggleTheme);
    $("refresh-btn").addEventListener("click", () => refreshAll(true));
    $("brand-home").addEventListener("click", () => switchMainView("personal"));

    $("sidebar-toggle").addEventListener("click", () => {
      const open = $("tickers-sidebar").classList.toggle("open");
      $("sidebar-scrim").classList.toggle("hidden", !open);
    });
    $("sidebar-scrim").addEventListener("click", closeMobileSidebar);

    $("account-btn").addEventListener("click", async () => {
      if (state.forced) return;
      if (state.brokerTimer) clearTimeout(state.brokerTimer);
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-Requested-With": "EyriWeb" },
      }).catch(() => {});
      state.user = null;
      state.overview = null;
      state.personalData = null;
      state.tickerData = null;
      showLogin();
    });

    document.querySelectorAll("[data-main-view]").forEach((btn) => {
      btn.addEventListener("click", () => switchMainView(btn.dataset.mainView));
    });

    document.querySelectorAll("#sidebar-tabs .rail-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.panelTab = btn.dataset.panelTab;
        state.panelTabChosen = true;
        document.querySelectorAll("#sidebar-tabs .rail-tab").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderTickersSidebar();
      });
    });
    $("sidebar-sort").addEventListener("change", (e) => {
      state.panelSort = e.target.value;
      renderTickersSidebar();
    });
    $("sidebar-filter").addEventListener("input", (e) => {
      state.panelFilter = e.target.value;
      renderTickersSidebar();
    });
    $("sidebar-add-btn").addEventListener("click", async () => {
      const sym = $("sidebar-filter").value.trim().toUpperCase();
      if (!sym) { $("global-search").focus(); return; }
      $("sidebar-filter").value = "";
      state.panelFilter = "";
      if (!state.watchlist.includes(sym)) await toggleWatchlist(sym);
      openTicker(sym);
    });

    document.querySelectorAll("#personal-kind-group .u-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.personalKind = btn.dataset.kind;
        document.querySelectorAll("#personal-kind-group .u-tab").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        loadPersonalChart();
      });
    });
    document.querySelectorAll("#personal-unit-group .sw-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        state.personalUnit = btn.dataset.unit;
        document.querySelectorAll("#personal-unit-group .sw-btn").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderPersonalChart();
      });
    });
    document.querySelectorAll("#personal-range-group .r-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.personalRange = btn.dataset.prange;
        document.querySelectorAll("#personal-range-group .r-btn").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderPersonalChart();
      });
    });
    $("personal-benchmark").addEventListener("change", (e) => {
      state.personalBenchmark = e.target.value;
      loadPersonalChart();
    });
    $("personal-filter").addEventListener("change", (e) => {
      state.personalFilter = e.target.value;
      loadOverview();
      loadPersonalChart();
    });
    $("personal-bucket").addEventListener("change", (e) => {
      state.personalBucket = e.target.value;
      loadOverview();
      loadPersonalChart();
    });
    $("personal-toggle-kp").addEventListener("click", (e) => {
      state.personalShowKp = !state.personalShowKp;
      e.currentTarget.classList.toggle("active", state.personalShowKp);
      renderPersonalChart();
    });
    $("personal-toggle-buys").addEventListener("click", (e) => {
      state.personalShowBuys = !state.personalShowBuys;
      e.currentTarget.classList.toggle("active", state.personalShowBuys);
      renderPersonalChart();
    });

    document.querySelectorAll("#portfolio-subview-tabs .u-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.portfolioSubView = btn.dataset.subview;
        document.querySelectorAll("#portfolio-subview-tabs .u-tab").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderPortfolioSubView();
      });
    });

    $("ticker-watch-btn").addEventListener("click", () => {
      if (state.tickerData?.symbol) toggleWatchlist(state.tickerData.symbol);
    });
    document.querySelectorAll("#ticker-range-group .r-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tickerRange = btn.dataset.trange;
        document.querySelectorAll("#ticker-range-group .r-btn").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        loadTickerView(state.activeSymbol);
      });
    });
    document.querySelectorAll("#ticker-style-group .sw-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tickerStyle = btn.dataset.style;
        document.querySelectorAll("#ticker-style-group .sw-btn").forEach((b) =>
          b.classList.toggle("active", b === btn)
        );
        renderTickerView();
      });
    });
    $("ticker-toggle-kp").addEventListener("click", (e) => {
      state.tickerShowKp = !state.tickerShowKp;
      e.currentTarget.classList.toggle("active", state.tickerShowKp);
      renderTickerView();
    });
    $("ticker-toggle-ext").addEventListener("click", (e) => {
      state.tickerShowExt = !state.tickerShowExt;
      e.currentTarget.classList.toggle("active", state.tickerShowExt);
      renderTickerView();
    });
    $("ticker-toggle-trades").addEventListener("click", (e) => {
      state.tickerShowTrades = !state.tickerShowTrades;
      e.currentTarget.classList.toggle("active", state.tickerShowTrades);
      renderTickerView();
    });
  }

  bindEvents();
  boot();
})();
