const state = {
  orderbooks: [],
  selected: null,
  loadingEvents: false,
  view: "events",
  replay: {
    dates: [],
    date: "",
    events: [],
    total: 0,
    firstTsEvent: null,
    lastTsEvent: null,
    offset: 0,
    index: -1,
    orders: new Map(),
    bids: new Map(),
    asks: new Map(),
    loading: false,
  },
  chart: {
    dates: [],
    date: "",
    events: [],
    total: 0,
    firstTsEvent: null,
    lastTsEvent: null,
    offset: 0,
    index: -1,
    candles: [],
    tradeCount: 0,
    lastEvent: null,
    lastTrade: null,
    loading: false,
    playing: false,
    timer: null,
    speedIndex: 2,
  },
  strategy: {
    dates: [],
    date: "",
    session: null,           // { bars, timeline, trades, summary }
    events: [],              // raw MBO events for the day
    total: 0,
    firstTsEvent: null,
    lastTsEvent: null,
    offset: 0,
    index: -1,
    lastEvent: null,
    lastTradePrice: null,
    timelineIndex: 0,        // pointer into session.timeline
    appliedEvents: [],       // strategy events that have fired so far (for log)
    position: null,          // { side, qty, entry, stop, target, breakeven }
    realizedPnl: 0,
    sessionLoading: false,
    chunkLoading: false,
    playing: false,
    timer: null,
    speedIndex: 2,
  },
};

const F_LAST = 128;
const BOOK_LEVEL_LIMIT = 100;
const CHART_VISIBLE_CANDLES = 90;
const CHART_SPEEDS = [
  { label: "0.25x", delay: 240, batch: 1 },
  { label: "0.5x", delay: 120, batch: 1 },
  { label: "1x", delay: 60, batch: 1 },
  { label: "2x", delay: 30, batch: 1 },
  { label: "4x", delay: 12, batch: 1 },
  { label: "8x", delay: 1, batch: 1 },
  { label: "20x", delay: 1, batch: 3 },
];
const DEFAULT_CHART_SPEED_INDEX = 2;
const THEME_STORAGE_KEY = "mbo-dashboard-theme";

const columns = [
  "ts_event",
  "ts_recv",
  "symbol",
  "instrument_id",
  "action",
  "side",
  "price_display",
  "size",
  "order_id",
  "sequence",
  "flags",
  "publisher_id",
  "channel_id",
];

const el = {
  orderbooks: document.querySelector("#orderbooks"),
  summary: document.querySelector("#summary"),
  filter: document.querySelector("#filter"),
  refresh: document.querySelector("#refresh"),
  themeToggle: document.querySelector("#theme-toggle"),
  selectedTitle: document.querySelector("#selected-title"),
  stats: document.querySelector("#stats"),
  limit: document.querySelector("#limit"),
  loadEvents: document.querySelector("#load-events"),
  firstHead: document.querySelector("#first-head"),
  firstBody: document.querySelector("#first-body"),
  lastHead: document.querySelector("#last-head"),
  lastBody: document.querySelector("#last-body"),
  firstCount: document.querySelector("#first-count"),
  lastCount: document.querySelector("#last-count"),
  tabs: document.querySelectorAll("[data-view]"),
  views: document.querySelectorAll(".view"),
  replayDate: document.querySelector("#replay-date"),
  replayOffset: document.querySelector("#replay-offset"),
  replayLimit: document.querySelector("#replay-limit"),
  replayLoad: document.querySelector("#replay-load"),
  replayPrev: document.querySelector("#replay-prev"),
  replayNext: document.querySelector("#replay-next"),
  replayPosition: document.querySelector("#replay-position"),
  replaySession: document.querySelector("#replay-session"),
  currentEvent: document.querySelector("#current-event"),
  eventEffect: document.querySelector("#event-effect"),
  bookBody: document.querySelector("#book-body"),
  bookCounts: document.querySelector("#book-counts"),
  chartDate: document.querySelector("#chart-date"),
  chartOffset: document.querySelector("#chart-offset"),
  chartLimit: document.querySelector("#chart-limit"),
  chartInterval: document.querySelector("#chart-interval"),
  chartLoad: document.querySelector("#chart-load"),
  chartStep: document.querySelector("#chart-step"),
  chartTrade: document.querySelector("#chart-trade"),
  chartPlay: document.querySelector("#chart-play"),
  chartSlower: document.querySelector("#chart-slower"),
  chartFaster: document.querySelector("#chart-faster"),
  chartSpeed: document.querySelector("#chart-speed"),
  chartPosition: document.querySelector("#chart-position"),
  chartSession: document.querySelector("#chart-session"),
  chartEvent: document.querySelector("#chart-event"),
  chartSummary: document.querySelector("#chart-summary"),
  candleChart: document.querySelector("#candle-chart"),
  strategyDate: document.querySelector("#strategy-date"),
  strategyLimit: document.querySelector("#strategy-limit"),
  strategyLoad: document.querySelector("#strategy-load"),
  strategyStep: document.querySelector("#strategy-step"),
  strategyNextBar: document.querySelector("#strategy-next-bar"),
  strategyNextSignal: document.querySelector("#strategy-next-signal"),
  strategyPlay: document.querySelector("#strategy-play"),
  strategySlower: document.querySelector("#strategy-slower"),
  strategyFaster: document.querySelector("#strategy-faster"),
  strategySpeed: document.querySelector("#strategy-speed"),
  strategyPosition: document.querySelector("#strategy-position"),
  strategySession: document.querySelector("#strategy-session"),
  strategyEvent: document.querySelector("#strategy-event"),
  strategySummary: document.querySelector("#strategy-summary"),
  strategyChart: document.querySelector("#strategy-chart"),
  strategyPositionPanel: document.querySelector("#strategy-position-panel"),
  strategySignals: document.querySelector("#strategy-signals"),
  strategyPnlReadout: document.querySelector("#strategy-pnl-readout"),
  strategyTradeCount: document.querySelector("#strategy-trade-count"),
};

function preferredTheme() {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  el.themeToggle.textContent = theme === "dark" ? "☀" : "◐";
  el.themeToggle.title = theme === "dark" ? "Use light theme" : "Use dark theme";
  el.themeToggle.setAttribute("aria-label", el.themeToggle.title);
}

function formatNumber(value) {
  return new Intl.NumberFormat().format(value ?? 0);
}

function formatPrice(value) {
  if (value === null || value === undefined) return "";
  return Number(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 9,
  });
}

function formatTime(value) {
  if (!value) return "";
  return value
    .replace("T", " ")
    .replace("-04:00", " EDT")
    .replace("-05:00", " EST");
}

function displayValue(column, value) {
  if (column === "price_display") return formatPrice(value);
  if (column.startsWith("ts_")) return formatTime(value);
  if (typeof value === "number") return formatNumber(value);
  return value ?? "";
}

function sideName(side) {
  if (side === "B") return "Bid";
  if (side === "A") return "Ask";
  return "None";
}

async function fetchJson(url) {
  const response = await fetch(url);
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

async function loadOrderbooks() {
  el.summary.textContent = "Loading orderbooks...";
  el.orderbooks.innerHTML = "";
  const payload = await fetchJson("/api/orderbooks");
  state.orderbooks = payload.orderbooks;
  state.selected = state.orderbooks[0] || null;
  renderOrderbooks();
  renderSelected();
  if (state.selected) {
    await loadEvents();
  }
}

async function loadReplayDates() {
  el.replayDate.disabled = true;
  el.chartDate.disabled = true;
  el.strategyDate.disabled = true;
  el.replayLoad.disabled = true;
  el.chartLoad.disabled = true;
  el.strategyLoad.disabled = true;
  el.replayDate.innerHTML = `<option value="">Loading</option>`;
  el.chartDate.innerHTML = `<option value="">Loading</option>`;
  el.strategyDate.innerHTML = `<option value="">Loading</option>`;
  const payload = await fetchJson("/api/replay-dates");
  state.replay.dates = payload.dates || [];
  state.chart.dates = state.replay.dates;
  state.strategy.dates = state.replay.dates;
  renderReplayDates();
  renderChartDates();
  renderStrategyDates();
  el.replayLoad.disabled = false;
  el.chartLoad.disabled = false;
  el.strategyLoad.disabled = false;
}

function renderSessionOptions(select, dates, currentDate) {
  select.innerHTML = "";

  if (!dates.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "All dates";
    select.appendChild(option);
    return "";
  }

  for (const session of dates) {
    const option = document.createElement("option");
    option.value = session.date;
    option.textContent = session.date;
    select.appendChild(option);
  }
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All dates";
  select.appendChild(allOption);

  const existing = dates.some((session) => session.date === currentDate);
  const nextDate = existing ? currentDate : dates[0].date;
  select.value = nextDate;
  return nextDate;
}

function renderReplayDates() {
  const nextDate = renderSessionOptions(el.replayDate, state.replay.dates, state.replay.date);
  el.replayDate.disabled = false;
  setReplayDate(nextDate);
}

function renderChartDates() {
  const nextDate = renderSessionOptions(el.chartDate, state.chart.dates, state.chart.date);
  el.chartDate.disabled = false;
  setChartDate(nextDate);
}

function setReplayDate(date) {
  state.replay.date = date;
  el.replayDate.value = date;
  el.replayOffset.value = 0;
  state.replay.events = [];
  state.replay.total = 0;
  state.replay.firstTsEvent = null;
  state.replay.lastTsEvent = null;
  state.replay.offset = 0;
  state.replay.index = -1;
  clearReplayBook();
  renderReplaySession();
  renderReplay();
}

function setChartDate(date) {
  stopChartPlayback();
  state.chart.date = date;
  el.chartDate.value = date;
  el.chartOffset.value = 0;
  resetChartState();
  renderChartSession();
  renderChartEvent();
  drawCandles();
}

function resetChartState() {
  state.chart.events = [];
  state.chart.total = 0;
  state.chart.firstTsEvent = null;
  state.chart.lastTsEvent = null;
  state.chart.offset = 0;
  state.chart.index = -1;
  state.chart.candles = [];
  state.chart.tradeCount = 0;
  state.chart.lastEvent = null;
  state.chart.lastTrade = null;
}

function renderOrderbooks() {
  const query = el.filter.value.trim().toLowerCase();
  const visible = state.orderbooks.filter((book) => {
    return `${book.symbol} ${book.instrument_id}`.toLowerCase().includes(query);
  });

  el.summary.textContent = `${formatNumber(visible.length)} of ${formatNumber(state.orderbooks.length)} orderbooks`;
  el.orderbooks.innerHTML = "";

  for (const book of visible) {
    const button = document.createElement("button");
    button.className = "book";
    if (state.selected?.instrument_id === book.instrument_id) {
      button.classList.add("active");
    }
    button.innerHTML = `
      <span>
        <strong>${book.symbol}</strong>
        <small>${book.instrument_id}</small>
      </span>
      <em>${formatNumber(book.events)}</em>
    `;
    button.addEventListener("click", async () => {
      state.selected = book;
      renderOrderbooks();
      renderSelected();
      await loadEvents();
    });
    el.orderbooks.appendChild(button);
  }
}

function renderSelected() {
  const book = state.selected;
  if (!book) {
    el.selectedTitle.textContent = "No orderbook found";
    el.stats.innerHTML = "";
    return;
  }

  el.selectedTitle.textContent = `${book.symbol} · ${book.instrument_id}`;
  el.stats.innerHTML = `
    <div><span>Events</span><strong>${formatNumber(book.events)}</strong></div>
    <div><span>First Event</span><strong>${formatTime(book.first_ts_event)}</strong></div>
    <div><span>Last Event</span><strong>${formatTime(book.last_ts_event)}</strong></div>
  `;
}

function setView(view) {
  state.view = view;
  el.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  el.views.forEach((panel) => panel.classList.toggle("active", panel.id === `${view}-view`));
  if (view === "chart") requestAnimationFrame(drawCandles);
  if (view === "strategy") requestAnimationFrame(drawStrategyChart);
}

async function loadEvents() {
  if (!state.selected || state.loadingEvents) return;

  state.loadingEvents = true;
  el.loadEvents.disabled = true;
  el.loadEvents.textContent = "Loading";
  clearTable("first");
  clearTable("last");

  try {
    const limit = Number(el.limit.value || 200);
    const payload = await fetchJson(`/api/events?instrument_id=${state.selected.instrument_id}&limit=${limit}`);
    renderTable("first", payload.first);
    renderTable("last", payload.last);
  } finally {
    state.loadingEvents = false;
    el.loadEvents.disabled = false;
    el.loadEvents.textContent = "Load";
  }
}

function clearTable(kind) {
  document.querySelector(`#${kind}-head`).innerHTML = "";
  document.querySelector(`#${kind}-body`).innerHTML = `<tr><td class="empty">Loading events...</td></tr>`;
  document.querySelector(`#${kind}-count`).textContent = "";
}

function renderTable(kind, rows) {
  const head = document.querySelector(`#${kind}-head`);
  const body = document.querySelector(`#${kind}-body`);
  const count = document.querySelector(`#${kind}-count`);
  const availableColumns = columns.filter((column) => rows.some((row) => column in row));

  count.textContent = `${formatNumber(rows.length)} rows`;
  head.innerHTML = `<tr>${availableColumns.map((column) => `<th>${column}</th>`).join("")}</tr>`;
  body.innerHTML = "";

  if (!rows.length) {
    body.innerHTML = `<tr><td class="empty" colspan="${availableColumns.length || 1}">No events found</td></tr>`;
    return;
  }

  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = availableColumns
      .map((column) => `<td>${displayValue(column, row[column])}</td>`)
      .join("");
    body.appendChild(tr);
  }
}

function clearReplayBook() {
  state.replay.orders = new Map();
  state.replay.bids = new Map();
  state.replay.asks = new Map();
}

function levelMap(side) {
  return side === "B" ? state.replay.bids : state.replay.asks;
}

function adjustLevel(side, price, sizeDelta, countDelta) {
  if (side !== "A" && side !== "B") return;
  if (price === null || price === undefined) return;
  const levels = levelMap(side);
  const current = levels.get(price) || { size: 0, count: 0 };
  current.size += sizeDelta;
  current.count += countDelta;
  if (current.size <= 0 || current.count <= 0) {
    levels.delete(price);
  } else {
    levels.set(price, current);
  }
}

function removeOrder(orderId) {
  const existing = state.replay.orders.get(orderId);
  if (!existing) return null;
  adjustLevel(existing.side, existing.price, -existing.size, -1);
  state.replay.orders.delete(orderId);
  return existing;
}

function addOrder(event) {
  if (event.side !== "A" && event.side !== "B") return null;
  if (!event.order_id || event.price_display === null || event.price_display === undefined) return null;
  removeOrder(event.order_id);
  const order = {
    side: event.side,
    price: event.price_display,
    size: event.size,
    ts_event: event.ts_event,
  };
  state.replay.orders.set(event.order_id, order);
  adjustLevel(order.side, order.price, order.size, 1);
  return order;
}

function applyReplayEvent(event) {
  const action = event.action;
  const orderId = event.order_id;
  const before = state.replay.orders.get(orderId);

  if (action === "R") {
    const removed = state.replay.orders.size;
    clearReplayBook();
    return `Cleared ${formatNumber(removed)} resting orders.`;
  }

  if (action === "A") {
    const order = addOrder(event);
    if (!order) return "Add carried no resting order to insert.";
    return `Added ${formatNumber(order.size)} @ ${formatPrice(order.price)} on ${sideName(order.side)}.`;
  }

  if (action === "C") {
    if (!before) return "Cancel referenced an order that is not in the local replay state.";
    const cancelSize = Math.min(event.size, before.size);
    adjustLevel(before.side, before.price, -cancelSize, cancelSize === before.size ? -1 : 0);
    before.size -= cancelSize;
    if (before.size <= 0) state.replay.orders.delete(orderId);
    return `Canceled ${formatNumber(cancelSize)} from ${sideName(before.side)} order ${orderId}.`;
  }

  if (action === "M") {
    const old = removeOrder(orderId);
    const updated = addOrder(event);
    if (!old && updated) {
      return `Modified order was not present locally, inserted ${formatNumber(updated.size)} @ ${formatPrice(updated.price)}.`;
    }
    if (!updated) return "Modify removed or could not recreate the resting order.";
    return `Modified ${orderId} from ${formatNumber(old.size)} @ ${formatPrice(old.price)} to ${formatNumber(updated.size)} @ ${formatPrice(updated.price)}.`;
  }

  if (action === "T" || action === "F" || action === "N") {
    return `${action} does not change resting order state.`;
  }

  return `Unhandled action ${action}.`;
}

async function loadReplayChunk({ preserveBook = false } = {}) {
  if (state.replay.loading) return;
  state.replay.loading = true;
  el.replayLoad.disabled = true;
  el.replayNext.disabled = true;
  el.replayPrev.disabled = true;
  el.currentEvent.textContent = "Loading replay events...";

  try {
    const offset = Number(el.replayOffset.value || 0);
    const limit = Number(el.replayLimit.value || 1000);
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
    });
    if (el.replayDate.value) params.set("date", el.replayDate.value);
    const payload = await fetchJson(`/api/replay?${params}`);
    state.replay.date = payload.date || el.replayDate.value || "";
    state.replay.events = payload.events;
    state.replay.total = payload.total;
    state.replay.firstTsEvent = payload.first_ts_event;
    state.replay.lastTsEvent = payload.last_ts_event;
    state.replay.offset = payload.offset;
    state.replay.index = -1;
    if (!preserveBook) clearReplayBook();
    renderReplaySession();
    renderReplay();
    if (state.replay.events.length) stepReplay(1);
  } finally {
    state.replay.loading = false;
    el.replayLoad.disabled = false;
    el.replayNext.disabled = false;
    el.replayPrev.disabled = false;
  }
}

async function stepReplay(direction) {
  if (direction < 0) {
    el.eventEffect.textContent = "Previous is available within the event list, but book state replay is forward-only. Reload the chunk to restart from its first event.";
    return;
  }

  const nextIndex = state.replay.index + 1;
  if (nextIndex >= state.replay.events.length) {
    const nextOffset = state.replay.offset + state.replay.events.length;
    if (nextOffset >= state.replay.total) return;
    el.replayOffset.value = nextOffset;
    await loadReplayChunk({ preserveBook: true });
    return;
  }

  state.replay.index = nextIndex;
  const event = state.replay.events[state.replay.index];
  const effect = applyReplayEvent(event);
  renderReplay(event, effect);
}

function renderReplaySession() {
  if (!state.replay.total) {
    el.replaySession.textContent = "Choose a session and load replay rows.";
    return;
  }

  el.replaySession.innerHTML = `
    <dl>
      <div><dt>Rows</dt><dd>${formatNumber(state.replay.total)}</dd></div>
      <div><dt>Session</dt><dd>${state.replay.date || "All dates"}</dd></div>
      <div><dt>First Event</dt><dd>${formatTime(state.replay.firstTsEvent)}</dd></div>
      <div><dt>Last Event</dt><dd>${formatTime(state.replay.lastTsEvent)}</dd></div>
    </dl>
  `;
}

function renderReplay(event = null, effect = "") {
  const absoluteRow = event ? event.row + 1 : state.replay.offset;
  el.replayPosition.textContent = `${formatNumber(absoluteRow)} / ${formatNumber(state.replay.total)}`;

  if (!event) {
    el.currentEvent.textContent = "Load a replay chunk to begin.";
    el.eventEffect.textContent = "";
    renderBookLevels();
    return;
  }

  const inspectAfterEvent = (event.flags & F_LAST) === F_LAST;
  el.currentEvent.innerHTML = `
    <dl>
      <div><dt>Row</dt><dd>${formatNumber(event.row)}</dd></div>
      <div><dt>Sequence</dt><dd>${formatNumber(event.sequence)}</dd></div>
      <div><dt>Event Time</dt><dd>${formatTime(event.ts_event)}</dd></div>
      <div><dt>Recv Time</dt><dd>${formatTime(event.ts_recv)}</dd></div>
      <div><dt>Action</dt><dd>${event.action}</dd></div>
      <div><dt>Side</dt><dd>${sideName(event.side)}</dd></div>
      <div><dt>Price</dt><dd>${formatPrice(event.price_display)}</dd></div>
      <div><dt>Size</dt><dd>${formatNumber(event.size)}</dd></div>
      <div><dt>Order</dt><dd>${formatNumber(event.order_id)}</dd></div>
      <div><dt>F_LAST</dt><dd>${inspectAfterEvent ? "Yes" : "No"}</dd></div>
    </dl>
  `;
  el.eventEffect.textContent = inspectAfterEvent
    ? effect
    : `${effect} More records may belong to this normalized event.`;
  renderBookLevels();
}

function renderBookLevels() {
  const bids = Array.from(state.replay.bids.entries())
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .slice(0, BOOK_LEVEL_LIMIT);
  const asks = Array.from(state.replay.asks.entries())
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .slice(0, BOOK_LEVEL_LIMIT);
  const rows = Math.max(BOOK_LEVEL_LIMIT, bids.length, asks.length);

  el.bookCounts.textContent = `${formatNumber(state.replay.orders.size)} resting orders`;
  el.bookBody.innerHTML = "";
  for (let index = 0; index < rows; index += 1) {
    const bid = bids[index];
    const ask = asks[index];
    const bidClass = index === 0 && bid ? "best-bid" : "";
    const askClass = index === 0 && ask ? "best-ask" : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="${bidClass}">${bid ? formatNumber(bid[1].count) : ""}</td>
      <td class="${bidClass}">${bid ? formatNumber(bid[1].size) : ""}</td>
      <td class="bid ${bidClass}">${bid ? formatPrice(bid[0]) : ""}</td>
      <td class="ask ${askClass}">${ask ? formatPrice(ask[0]) : ""}</td>
      <td class="${askClass}">${ask ? formatNumber(ask[1].size) : ""}</td>
      <td class="${askClass}">${ask ? formatNumber(ask[1].count) : ""}</td>
    `;
    el.bookBody.appendChild(tr);
  }
}

async function loadChartChunk({ preserveCandles = false } = {}) {
  if (state.chart.loading) return;
  state.chart.loading = true;
  setChartButtonsDisabled(true);
  el.chartEvent.textContent = "Loading events...";

  try {
    const offset = Number(el.chartOffset.value || 0);
    const limit = Number(el.chartLimit.value || 10000);
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
    });
    if (el.chartDate.value) params.set("date", el.chartDate.value);

    const payload = await fetchJson(`/api/replay?${params}`);
    state.chart.date = payload.date || el.chartDate.value || "";
    state.chart.events = payload.events;
    state.chart.total = payload.total;
    state.chart.firstTsEvent = payload.first_ts_event;
    state.chart.lastTsEvent = payload.last_ts_event;
    state.chart.offset = payload.offset;
    state.chart.index = -1;
    state.chart.lastEvent = null;

    if (!preserveCandles) {
      state.chart.candles = [];
      state.chart.tradeCount = 0;
      state.chart.lastTrade = null;
    }

    renderChartSession();
    renderChartEvent();
    drawCandles();
  } finally {
    state.chart.loading = false;
    setChartButtonsDisabled(false);
  }
}

async function handleChartLoad() {
  stopChartPlayback();
  await loadChartChunk();
  await stepChart(1);
}

async function stepChart(direction, { render = true } = {}) {
  if (direction < 0 || state.chart.loading) return null;

  if (!state.chart.events.length) {
    await loadChartChunk();
    if (!state.chart.events.length) return null;
  }

  const nextIndex = state.chart.index + 1;
  if (nextIndex >= state.chart.events.length) {
    const nextOffset = state.chart.offset + state.chart.events.length;
    if (nextOffset >= state.chart.total) {
      stopChartPlayback();
      return null;
    }
    el.chartOffset.value = nextOffset;
    await loadChartChunk({ preserveCandles: true });
    return stepChart(1, { render });
  }

  state.chart.index = nextIndex;
  const event = state.chart.events[state.chart.index];
  state.chart.lastEvent = event;
  applyChartEvent(event);
  if (render) {
    renderChartEvent(event);
    drawCandles();
  }
  return event;
}

async function stepChartToNextTrade() {
  stopChartPlayback();
  setChartButtonsDisabled(true);
  let event = null;

  try {
    for (let skipped = 0; skipped < 250000; skipped += 1) {
      event = await stepChart(1, { render: false });
      if (!event || isTradeEvent(event)) break;
    }
  } finally {
    setChartButtonsDisabled(false);
    renderChartEvent(event || state.chart.lastEvent);
    drawCandles();
  }
}

function isTradeEvent(event) {
  return event?.action === "T" && event.price_display !== null && event.price_display !== undefined;
}

function applyChartEvent(event) {
  if (!isTradeEvent(event)) return false;

  const price = Number(event.price_display);
  const size = Number(event.size || 0);
  const timestamp = new Date(event.ts_event).getTime();
  const interval = Number(el.chartInterval.value || 60000);
  if (!Number.isFinite(price) || !Number.isFinite(timestamp)) return false;

  const start = Math.floor(timestamp / interval) * interval;
  let candle = state.chart.candles[state.chart.candles.length - 1];
  if (!candle || candle.start !== start) {
    candle = {
      start,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      trades: 0,
      lastTsEvent: event.ts_event,
    };
    state.chart.candles.push(candle);
  }

  candle.high = Math.max(candle.high, price);
  candle.low = Math.min(candle.low, price);
  candle.close = price;
  candle.volume += size;
  candle.trades += 1;
  candle.lastTsEvent = event.ts_event;
  state.chart.tradeCount += 1;
  state.chart.lastTrade = event;
  return true;
}

function renderChartSession() {
  if (!state.chart.total) {
    el.chartSession.textContent = "Choose a session and load events.";
    return;
  }

  el.chartSession.innerHTML = `
    <dl>
      <div><dt>Rows</dt><dd>${formatNumber(state.chart.total)}</dd></div>
      <div><dt>Session</dt><dd>${state.chart.date || "All dates"}</dd></div>
      <div><dt>First Event</dt><dd>${formatTime(state.chart.firstTsEvent)}</dd></div>
      <div><dt>Last Event</dt><dd>${formatTime(state.chart.lastTsEvent)}</dd></div>
    </dl>
  `;
}

function renderChartEvent(event = state.chart.lastEvent) {
  const absoluteRow = event ? event.row + 1 : state.chart.offset;
  el.chartPosition.textContent = `${formatNumber(absoluteRow)} / ${formatNumber(state.chart.total)}`;
  renderChartSummary();

  if (!event) {
    el.chartEvent.textContent = "Load an event chunk to begin.";
    return;
  }

  const trade = isTradeEvent(event);
  el.chartEvent.innerHTML = `
    <dl>
      <div><dt>Row</dt><dd>${formatNumber(event.row)}</dd></div>
      <div><dt>Sequence</dt><dd>${formatNumber(event.sequence)}</dd></div>
      <div><dt>Event Time</dt><dd>${formatTime(event.ts_event)}</dd></div>
      <div><dt>Recv Time</dt><dd>${formatTime(event.ts_recv)}</dd></div>
      <div><dt>Action</dt><dd>${event.action}</dd></div>
      <div><dt>Candle Update</dt><dd>${trade ? "Yes" : "No"}</dd></div>
      <div><dt>Price</dt><dd>${formatPrice(event.price_display)}</dd></div>
      <div><dt>Size</dt><dd>${formatNumber(event.size)}</dd></div>
    </dl>
  `;
}

function renderChartSummary() {
  const last = state.chart.candles[state.chart.candles.length - 1];
  if (!last) {
    el.chartSummary.textContent = `${formatNumber(state.chart.tradeCount)} trades`;
    return;
  }

  el.chartSummary.textContent = [
    `${formatNumber(state.chart.tradeCount)} trades`,
    `${formatNumber(state.chart.candles.length)} candles`,
    `O ${formatPrice(last.open)}`,
    `H ${formatPrice(last.high)}`,
    `L ${formatPrice(last.low)}`,
    `C ${formatPrice(last.close)}`,
  ].join(" · ");
}

function setChartButtonsDisabled(disabled) {
  el.chartLoad.disabled = disabled;
  el.chartStep.disabled = disabled;
  el.chartTrade.disabled = disabled;
  el.chartPlay.disabled = disabled;
  el.chartSlower.disabled = disabled && !state.chart.playing;
  el.chartFaster.disabled = disabled && !state.chart.playing;
  updateChartSpeedControls();
}

function startChartPlayback() {
  if (state.chart.playing) return;
  state.chart.playing = true;
  el.chartPlay.textContent = "Pause";
  runChartPlayback();
}

function stopChartPlayback() {
  state.chart.playing = false;
  el.chartPlay.textContent = "Play";
  if (state.chart.timer) {
    clearTimeout(state.chart.timer);
    state.chart.timer = null;
  }
}

async function runChartPlayback() {
  if (!state.chart.playing) return;
  const batch = currentChartBatch();
  for (let i = 0; i < batch - 1; i += 1) {
    const skipEvent = await stepChart(1, { render: false });
    if (!skipEvent) { stopChartPlayback(); return; }
    if (!state.chart.playing) return;
  }
  const event = await stepChart(1);
  if (!event) {
    stopChartPlayback();
    return;
  }
  state.chart.timer = setTimeout(runChartPlayback, currentChartDelay());
}

function currentChartDelay() {
  return CHART_SPEEDS[state.chart.speedIndex].delay;
}

function currentChartBatch() {
  return CHART_SPEEDS[state.chart.speedIndex].batch ?? 1;
}

function adjustChartSpeed(delta) {
  const nextIndex = Math.max(0, Math.min(CHART_SPEEDS.length - 1, state.chart.speedIndex + delta));
  state.chart.speedIndex = nextIndex;
  updateChartSpeedControls();
}

function updateChartSpeedControls() {
  const speed = CHART_SPEEDS[state.chart.speedIndex];
  el.chartSpeed.textContent = speed.label;
  el.chartSlower.disabled = state.chart.speedIndex === 0 || (state.chart.loading && !state.chart.playing);
  el.chartFaster.disabled = state.chart.speedIndex === CHART_SPEEDS.length - 1 || (state.chart.loading && !state.chart.playing);
}

function themeColor(name) {
  return getComputedStyle(document.body).getPropertyValue(name).trim();
}

function formatAxisTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

function drawCandles() {
  const canvas = el.candleChart;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const surface = themeColor("--surface");
  const text = themeColor("--text");
  const muted = themeColor("--muted");
  const line = themeColor("--line");
  const bid = themeColor("--bid");
  const ask = themeColor("--ask");

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, width, height);

  const plot = {
    left: 14,
    right: width - 76,
    top: 18,
    bottom: height - 34,
  };
  const plotWidth = Math.max(1, plot.right - plot.left);
  const plotHeight = Math.max(1, plot.bottom - plot.top);
  const visible = state.chart.candles.slice(-CHART_VISIBLE_CANDLES);

  ctx.font = "12px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";

  if (!visible.length) {
    ctx.fillStyle = muted;
    ctx.textAlign = "center";
    ctx.fillText("No trades yet", width / 2, height / 2);
    renderChartSummary();
    return;
  }

  let minPrice = Math.min(...visible.map((candle) => candle.low));
  let maxPrice = Math.max(...visible.map((candle) => candle.high));
  if (minPrice === maxPrice) {
    minPrice -= 1;
    maxPrice += 1;
  } else {
    const padding = (maxPrice - minPrice) * 0.08;
    minPrice -= padding;
    maxPrice += padding;
  }

  const priceToY = (price) => {
    return plot.top + ((maxPrice - price) / (maxPrice - minPrice)) * plotHeight;
  };

  ctx.strokeStyle = line;
  ctx.fillStyle = muted;
  ctx.textAlign = "left";
  for (let index = 0; index <= 4; index += 1) {
    const y = plot.top + (plotHeight / 4) * index;
    const price = maxPrice - ((maxPrice - minPrice) / 4) * index;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.fillText(formatPrice(price), plot.right + 8, y);
  }

  const spacing = plotWidth / visible.length;
  const bodyWidth = Math.max(3, Math.min(12, spacing * 0.58));
  visible.forEach((candle, index) => {
    const x = plot.left + spacing * index + spacing / 2;
    const yOpen = priceToY(candle.open);
    const yClose = priceToY(candle.close);
    const yHigh = priceToY(candle.high);
    const yLow = priceToY(candle.low);
    const up = candle.close >= candle.open;
    const color = up ? bid : ask;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
  });

  const last = visible[visible.length - 1];
  const lastY = priceToY(last.close);
  ctx.strokeStyle = text;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(plot.left, lastY);
  ctx.lineTo(plot.right, lastY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = text;
  ctx.fillText(formatPrice(last.close), plot.right + 8, lastY);

  ctx.fillStyle = muted;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(formatAxisTime(visible[0].start), plot.left, height - 12);
  ctx.textAlign = "right";
  ctx.fillText(formatAxisTime(last.start), plot.right, height - 12);
  renderChartSummary();
}

// ============================================================================
// Strategy Replay tab
// ============================================================================

function renderStrategyDates() {
  const nextDate = renderSessionOptions(el.strategyDate, state.strategy.dates, state.strategy.date);
  el.strategyDate.disabled = false;
  setStrategyDate(nextDate);
}

function setStrategyDate(date) {
  stopStrategyPlayback();
  state.strategy.date = date;
  el.strategyDate.value = date;
  resetStrategyState();
  renderStrategySession();
  renderStrategyEvent();
  renderStrategyPosition();
  renderSignalsLog();
  drawStrategyChart();
}

function resetStrategyState() {
  state.strategy.session = null;
  state.strategy.events = [];
  state.strategy.total = 0;
  state.strategy.firstTsEvent = null;
  state.strategy.lastTsEvent = null;
  state.strategy.offset = 0;
  state.strategy.index = -1;
  state.strategy.lastEvent = null;
  state.strategy.lastTradePrice = null;
  state.strategy.timelineIndex = 0;
  state.strategy.appliedEvents = [];
  state.strategy.position = null;
  state.strategy.realizedPnl = 0;
  state.strategy.buildingBar = null;
}

async function loadStrategySession() {
  if (!state.strategy.date) return;
  if (state.strategy.sessionLoading) return;
  state.strategy.sessionLoading = true;
  setStrategyButtonsDisabled(true);
  el.strategyEvent.textContent = "Running engine...";
  try {
    const params = new URLSearchParams({ date: state.strategy.date });
    const payload = await fetchJson(`/api/strategy-session?${params}`);
    state.strategy.session = payload;
    resetTimelineApplication();
    await loadStrategyChunk();
    renderStrategySession();
    renderStrategyEvent();
    renderStrategyPosition();
    renderSignalsLog();
    drawStrategyChart();
  } finally {
    state.strategy.sessionLoading = false;
    setStrategyButtonsDisabled(false);
  }
}

function resetTimelineApplication() {
  state.strategy.timelineIndex = 0;
  state.strategy.appliedEvents = [];
  state.strategy.position = null;
  state.strategy.realizedPnl = 0;
  state.strategy.lastTradePrice = null;
  state.strategy.buildingBar = null;
}

async function loadStrategyChunk({ preserveProgress = false } = {}) {
  if (state.strategy.chunkLoading) return;
  state.strategy.chunkLoading = true;
  try {
    const limit = Number(el.strategyLimit.value || 5000);
    const offset = state.strategy.offset;
    const params = new URLSearchParams({
      date: state.strategy.date,
      offset: String(offset),
      limit: String(limit),
      rth_only: "true",
    });
    const payload = await fetchJson(`/api/replay?${params}`);
    state.strategy.events = payload.events;
    state.strategy.total = payload.total;
    state.strategy.firstTsEvent = payload.first_ts_event;
    state.strategy.lastTsEvent = payload.last_ts_event;
    state.strategy.offset = payload.offset;
    if (!preserveProgress) {
      state.strategy.index = -1;
      state.strategy.lastEvent = null;
    }
  } finally {
    state.strategy.chunkLoading = false;
  }
}

async function advanceToNextStrategyDate() {
  if (state.strategy.sessionLoading) return false;
  const dates = (state.strategy.dates || []).map((d) => d.date);
  const currentIdx = dates.indexOf(state.strategy.date);
  if (currentIdx < 0 || currentIdx + 1 >= dates.length) return false;
  const nextDate = dates[currentIdx + 1];
  state.strategy.sessionLoading = true;
  try {
    state.strategy.date = nextDate;
    el.strategyDate.value = nextDate;
    const params = new URLSearchParams({ date: nextDate });
    const payload = await fetchJson(`/api/strategy-session?${params}`);
    state.strategy.session = payload;
    resetTimelineApplication();
    state.strategy.offset = 0;
    state.strategy.index = -1;
    state.strategy.events = [];
    state.strategy.lastEvent = null;
    await loadStrategyChunk();
    renderStrategySession();
    return true;
  } finally {
    state.strategy.sessionLoading = false;
  }
}

async function stepStrategy(direction, { render = true } = {}) {
  if (direction < 0) return null;
  if (state.strategy.chunkLoading) return null;
  if (!state.strategy.events.length) {
    await loadStrategyChunk();
    if (!state.strategy.events.length) return null;
  }

  const nextIndex = state.strategy.index + 1;
  if (nextIndex >= state.strategy.events.length) {
    const nextOffset = state.strategy.offset + state.strategy.events.length;
    if (nextOffset >= state.strategy.total) {
      const advanced = await advanceToNextStrategyDate();
      if (!advanced) {
        stopStrategyPlayback();
        return null;
      }
      return stepStrategy(1, { render });
    }
    state.strategy.offset = nextOffset;
    await loadStrategyChunk({ preserveProgress: true });
    state.strategy.index = -1;
    return stepStrategy(1, { render });
  }

  state.strategy.index = nextIndex;
  const event = state.strategy.events[state.strategy.index];
  state.strategy.lastEvent = event;
  applyStrategyEvent(event);

  if (render) {
    renderStrategyEvent(event);
    renderStrategyPosition();
    renderSignalsLog();
    drawStrategyChart();
  }
  return event;
}

function applyStrategyEvent(event) {
  if (isTradeEvent(event)) {
    state.strategy.lastTradePrice = Number(event.price_display);
  }
  updateStrategyBuildingBar(event);
  const timeline = state.strategy.session?.timeline || [];
  const eventTime = new Date(event.ts_event).getTime();
  while (state.strategy.timelineIndex < timeline.length) {
    const next = timeline[state.strategy.timelineIndex];
    const nextTime = new Date(next.ts).getTime();
    if (nextTime > eventTime) break;
    applyTimelineEvent(next);
    state.strategy.timelineIndex += 1;
  }
}

function updateStrategyBuildingBar(event) {
  if (!isTradeEvent(event)) return;
  const bars = state.strategy.session?.bars || [];
  const closed = closedBarCountAtCurrent();
  const openBar = bars[closed];
  if (!openBar) {
    state.strategy.buildingBar = null;
    return;
  }
  const price = Number(event.price_display);
  if (!Number.isFinite(price)) return;
  const eventMs = new Date(event.ts_event).getTime();
  const startMs = new Date(openBar.bar_start).getTime();
  const endMs = new Date(openBar.bar_end).getTime();
  if (eventMs < startMs || eventMs >= endMs) return;
  const size = Number(event.size || 0);
  let building = state.strategy.buildingBar;
  if (!building || building.start !== openBar.bar_start) {
    building = {
      start: openBar.bar_start,
      end: openBar.bar_end,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
      inProgress: true,
    };
    state.strategy.buildingBar = building;
  }
  if (price > building.high) building.high = price;
  if (price < building.low) building.low = price;
  building.close = price;
  building.volume += size;
}

function applyTimelineEvent(entry) {
  const record = { ...entry };
  state.strategy.appliedEvents.push(record);

  if (entry.type === "fill") {
    state.strategy.position = {
      side: entry.side,
      qty: entry.qty,
      entry: entry.price,
      stop: entry.stop,
      target: entry.target,
      breakevenMoved: false,
    };
  } else if (entry.type === "breakeven") {
    if (state.strategy.position) {
      state.strategy.position.stop = entry.stop;
      state.strategy.position.breakevenMoved = true;
    }
  } else if (entry.type === "exit") {
    state.strategy.realizedPnl += entry.pnl_usd || 0;
    record.win = (entry.pnl_usd || 0) > 0;
    record.loss = (entry.pnl_usd || 0) < 0;
    state.strategy.position = null;
  }
}

function currentAbsoluteOffset() {
  return state.strategy.offset + Math.max(0, state.strategy.index);
}

async function seekStrategy(targetOffset) {
  if (targetOffset == null || targetOffset < 0) return null;
  if (targetOffset >= state.strategy.total) {
    stopStrategyPlayback();
    return null;
  }
  state.strategy.offset = targetOffset;
  state.strategy.index = -1;
  state.strategy.events = [];
  state.strategy.buildingBar = null;
  await loadStrategyChunk({ preserveProgress: false });
  return stepStrategy(1, { render: false });
}

async function advanceStrategyToNextBar({ render = true } = {}) {
  const bars = state.strategy.session?.bars || [];
  const nextBarIdx = closedBarCountAtCurrent();
  if (nextBarIdx >= bars.length) return null;
  const target = bars[nextBarIdx];
  if (target.event_offset == null) {
    const startBars = nextBarIdx;
    for (let i = 0; i < 1_000_000; i += 1) {
      const event = await stepStrategy(1, { render: false });
      if (!event) return null;
      if (closedBarCountAtCurrent() > startBars) break;
    }
  } else {
    await seekStrategy(target.event_offset);
  }
  const event = state.strategy.lastEvent;
  if (render && event) {
    renderStrategyEvent(event);
    renderStrategyPosition();
    renderSignalsLog();
    drawStrategyChart();
  }
  return event;
}

async function stepStrategyToNextBar() {
  stopStrategyPlayback();
  setStrategyButtonsDisabled(true);
  try {
    await advanceStrategyToNextBar({ render: true });
  } finally {
    setStrategyButtonsDisabled(false);
  }
}

async function stepStrategyToNextSignal() {
  stopStrategyPlayback();
  setStrategyButtonsDisabled(true);
  try {
    const timeline = state.strategy.session?.timeline || [];
    const currentOffset = currentAbsoluteOffset();
    const next = timeline.find(
      (e) => e.event_offset != null && e.event_offset > currentOffset
    );
    if (!next) return;   // no more strategy events for this session
    await seekStrategy(next.event_offset);
  } finally {
    setStrategyButtonsDisabled(false);
    renderStrategyEvent(state.strategy.lastEvent);
    renderStrategyPosition();
    renderSignalsLog();
    drawStrategyChart();
  }
}

function closedBarCountAtCurrent() {
  const event = state.strategy.lastEvent;
  const bars = state.strategy.session?.bars || [];
  if (!event || !bars.length) return 0;
  const cutoff = new Date(event.ts_event).getTime();
  let count = 0;
  for (const bar of bars) {
    if (new Date(bar.bar_end).getTime() <= cutoff) count += 1;
    else break;
  }
  return count;
}

function renderStrategySession() {
  if (!state.strategy.session) {
    el.strategySession.textContent = state.strategy.date
      ? "Click Load to run engine for this session."
      : "Choose a session and load.";
    el.strategySummary.textContent = "No data";
    return;
  }
  const s = state.strategy.session.summary || {};
  el.strategySession.innerHTML = `
    <dl>
      <div><dt>Date</dt><dd>${state.strategy.session.date}</dd></div>
      <div><dt>Instrument</dt><dd>${state.strategy.session.instrument}</dd></div>
      <div><dt>Bars</dt><dd>${formatNumber(state.strategy.session.bars.length)}</dd></div>
      <div><dt>Engine Trades</dt><dd>${formatNumber(s.trade_count || 0)} (${formatNumber(s.wins || 0)}W / ${formatNumber(s.losses || 0)}L)</dd></div>
      <div><dt>Engine P&amp;L</dt><dd class="${(s.total_pnl_usd || 0) >= 0 ? "pnl-positive" : "pnl-negative"}">${formatPnl(s.total_pnl_usd || 0)}</dd></div>
      <div><dt>Events</dt><dd>${formatNumber(state.strategy.total)}</dd></div>
    </dl>
  `;
}

function renderStrategyEvent(event = state.strategy.lastEvent) {
  const absoluteRow = event ? event.row + 1 : state.strategy.offset;
  el.strategyPosition.textContent = `${formatNumber(absoluteRow)} / ${formatNumber(state.strategy.total)}`;
  renderStrategySummary();
  if (!event) {
    el.strategyEvent.textContent = state.strategy.session
      ? "Step or play to walk events."
      : "Load a session to begin.";
    return;
  }
  const trade = isTradeEvent(event);
  el.strategyEvent.innerHTML = `
    <dl>
      <div><dt>Time</dt><dd>${formatTime(event.ts_event)}</dd></div>
      <div><dt>Action</dt><dd>${event.action}</dd></div>
      <div><dt>Price</dt><dd>${formatPrice(event.price_display)}</dd></div>
      <div><dt>Size</dt><dd>${formatNumber(event.size)}</dd></div>
      <div><dt>Trade?</dt><dd>${trade ? "Yes" : "No"}</dd></div>
      <div><dt>Last Trade</dt><dd>${formatPrice(state.strategy.lastTradePrice)}</dd></div>
    </dl>
  `;
}

function renderStrategySummary() {
  if (!state.strategy.session) {
    el.strategySummary.textContent = "No data";
    return;
  }
  const closed = closedBarCountAtCurrent();
  const lastBar = state.strategy.session.bars[Math.max(0, closed - 1)];
  if (!lastBar) {
    el.strategySummary.textContent = `${formatNumber(closed)} bars`;
    return;
  }
  el.strategySummary.textContent = [
    `${formatNumber(closed)} bars`,
    `buff ${formatPrice(lastBar.buff)}`,
    `atr ${lastBar.atr ? lastBar.atr.toFixed(2) : "—"}`,
    `rsi ${lastBar.rsi ? lastBar.rsi.toFixed(1) : "—"}`,
    `dir ${lastBar.dir > 0 ? "▲" : lastBar.dir < 0 ? "▼" : "·"}`,
  ].join(" · ");
}

function renderStrategyPosition() {
  const pos = state.strategy.position;
  const realized = state.strategy.realizedPnl;
  el.strategyPnlReadout.textContent = `Realized ${formatPnl(realized)}`;
  el.strategyTradeCount.textContent = `${formatNumber(state.strategy.appliedEvents.length)} events`;

  if (!pos) {
    el.strategyPositionPanel.className = "position-panel flat";
    el.strategyPositionPanel.textContent = state.strategy.session
      ? "Flat."
      : "No position.";
    return;
  }
  const sideClass = pos.side.toLowerCase();
  const mark = state.strategy.lastTradePrice;
  let unreal = null;
  let unrealClass = "";
  if (mark != null) {
    const delta = pos.side === "LONG" ? mark - pos.entry : pos.entry - mark;
    // MES tick = 0.25 = $1.25 / tick = $5 / point
    unreal = delta * 5 * pos.qty;
    unrealClass = unreal >= 0 ? "pnl-positive" : "pnl-negative";
  }
  el.strategyPositionPanel.className = `position-panel ${sideClass}`;
  el.strategyPositionPanel.innerHTML = `
    <dl>
      <div><dt>Side</dt><dd>${pos.side} × ${pos.qty}</dd></div>
      <div><dt>Entry</dt><dd>${formatPrice(pos.entry)}</dd></div>
      <div><dt>Stop ${pos.breakevenMoved ? "(BE)" : ""}</dt><dd>${formatPrice(pos.stop)}</dd></div>
      <div><dt>Target</dt><dd>${formatPrice(pos.target)}</dd></div>
      <div><dt>Mark</dt><dd>${formatPrice(mark)}</dd></div>
      <div><dt>Unrealized</dt><dd class="${unrealClass}">${unreal != null ? formatPnl(unreal) : "—"}</dd></div>
    </dl>
  `;
}

function renderSignalsLog() {
  const events = state.strategy.appliedEvents;
  if (!events.length) {
    el.strategySignals.className = "signals-log empty";
    el.strategySignals.textContent = "No events fired yet.";
    return;
  }
  el.strategySignals.className = "signals-log";
  const items = events.map((entry) => {
    const time = formatTime(entry.ts).slice(11, 19);
    const cls = entry.win ? "win" : entry.loss ? "loss" : "";
    const typeCls = `ev-${entry.type === "entry_skipped" ? "skipped" : entry.type === "gap_filter_active" || entry.type === "gap_resolved" ? "gap" : entry.type}`;
    let detail = "";
    if (entry.type === "signal") {
      detail = `${entry.side} @ ${formatPrice(entry.trigger_close)}`;
    } else if (entry.type === "fill") {
      detail = `${entry.side} ${entry.qty} @ ${formatPrice(entry.price)} (stop ${formatPrice(entry.stop)}, tgt ${formatPrice(entry.target)})`;
    } else if (entry.type === "exit") {
      detail = `${entry.side} @ ${formatPrice(entry.exit_price)} (${entry.reason}) ${formatPnl(entry.pnl_usd)}`;
    } else if (entry.type === "breakeven") {
      detail = `Stop → ${formatPrice(entry.stop)}`;
    } else if (entry.type === "entry_skipped") {
      detail = `${entry.reason}${entry.risk_ticks ? ` (${entry.risk_ticks.toFixed(1)} ticks, cap ${entry.cap})` : ""}`;
    } else {
      detail = JSON.stringify(entry);
    }
    return `<li class="${cls}"><span class="ev-time">${time}</span><span class="ev-type ${typeCls}">${entry.type}</span> ${detail}</li>`;
  }).reverse().join("");
  el.strategySignals.innerHTML = `<ul>${items}</ul>`;
}

function formatPnl(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const sign = value >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function setStrategyButtonsDisabled(disabled) {
  el.strategyLoad.disabled = disabled;
  el.strategyStep.disabled = disabled;
  el.strategyNextBar.disabled = disabled;
  el.strategyNextSignal.disabled = disabled;
  el.strategyPlay.disabled = disabled;
  el.strategySlower.disabled = disabled && !state.strategy.playing;
  el.strategyFaster.disabled = disabled && !state.strategy.playing;
  updateStrategySpeedControls();
}

function startStrategyPlayback() {
  if (state.strategy.playing) return;
  state.strategy.playing = true;
  el.strategyPlay.textContent = "Pause";
  runStrategyPlayback();
}

function stopStrategyPlayback() {
  state.strategy.playing = false;
  el.strategyPlay.textContent = "Play";
  if (state.strategy.timer) {
    clearTimeout(state.strategy.timer);
    state.strategy.timer = null;
  }
}

async function runStrategyPlayback() {
  if (!state.strategy.playing) return;
  const batch = currentStrategyBatch();
  for (let i = 0; i < batch - 1; i += 1) {
    const skipEvent = await stepStrategy(1, { render: false });
    if (!skipEvent) { stopStrategyPlayback(); return; }
    if (!state.strategy.playing) return;
  }
  const event = await stepStrategy(1);
  if (!event) { stopStrategyPlayback(); return; }
  state.strategy.timer = setTimeout(runStrategyPlayback, currentStrategyDelay());
}

function currentStrategyDelay() {
  return CHART_SPEEDS[state.strategy.speedIndex].delay;
}

function currentStrategyBatch() {
  return CHART_SPEEDS[state.strategy.speedIndex].batch ?? 1;
}

function adjustStrategySpeed(delta) {
  const nextIndex = Math.max(0, Math.min(CHART_SPEEDS.length - 1, state.strategy.speedIndex + delta));
  state.strategy.speedIndex = nextIndex;
  updateStrategySpeedControls();
}

function updateStrategySpeedControls() {
  const speed = CHART_SPEEDS[state.strategy.speedIndex];
  el.strategySpeed.textContent = speed.label;
  el.strategySlower.disabled = state.strategy.speedIndex === 0 || (state.strategy.chunkLoading && !state.strategy.playing);
  el.strategyFaster.disabled = state.strategy.speedIndex === CHART_SPEEDS.length - 1 || (state.strategy.chunkLoading && !state.strategy.playing);
}

function drawStrategyChart() {
  const canvas = el.strategyChart;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(rect.width * ratio);
  canvas.height = Math.floor(rect.height * ratio);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  const width = rect.width;
  const height = rect.height;
  const surface = themeColor("--surface");
  const text = themeColor("--text");
  const muted = themeColor("--muted");
  const line = themeColor("--line");
  const bid = themeColor("--bid");
  const ask = themeColor("--ask");
  const accent = themeColor("--accent-2");

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = surface;
  ctx.fillRect(0, 0, width, height);

  const plot = { left: 14, right: width - 76, top: 18, bottom: height - 34 };
  const plotWidth = Math.max(1, plot.right - plot.left);
  const plotHeight = Math.max(1, plot.bottom - plot.top);

  const bars = state.strategy.session?.bars || [];
  const closed = closedBarCountAtCurrent();
  const closedBars = bars.slice(0, closed);
  const building = state.strategy.buildingBar;
  const combined = building ? closedBars.concat([building]) : closedBars;
  const visible = combined.slice(-CHART_VISIBLE_CANDLES);

  ctx.font = "12px Inter, ui-sans-serif, system-ui, sans-serif";
  ctx.textBaseline = "middle";

  if (!visible.length) {
    ctx.fillStyle = muted;
    ctx.textAlign = "center";
    ctx.fillText(state.strategy.session ? "No bars yet — step forward" : "Load a session", width / 2, height / 2);
    return;
  }

  const pos = state.strategy.position;
  let minPrice = Infinity, maxPrice = -Infinity;
  for (const bar of visible) {
    if (bar.low < minPrice) minPrice = bar.low;
    if (bar.high > maxPrice) maxPrice = bar.high;
    if (bar.buff != null) {
      if (bar.buff < minPrice) minPrice = bar.buff;
      if (bar.buff > maxPrice) maxPrice = bar.buff;
    }
  }
  if (pos) {
    minPrice = Math.min(minPrice, pos.stop, pos.target);
    maxPrice = Math.max(maxPrice, pos.stop, pos.target);
  }
  if (minPrice === maxPrice) { minPrice -= 1; maxPrice += 1; }
  const padding = (maxPrice - minPrice) * 0.08;
  minPrice -= padding;
  maxPrice += padding;

  const priceToY = (price) => plot.top + ((maxPrice - price) / (maxPrice - minPrice)) * plotHeight;

  // gridlines + price axis labels
  ctx.strokeStyle = line;
  ctx.fillStyle = muted;
  ctx.textAlign = "left";
  for (let index = 0; index <= 4; index += 1) {
    const y = plot.top + (plotHeight / 4) * index;
    const price = maxPrice - ((maxPrice - minPrice) / 4) * index;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.fillText(formatPrice(price), plot.right + 8, y);
  }

  const spacing = plotWidth / visible.length;
  const bodyWidth = Math.max(3, Math.min(12, spacing * 0.58));

  // candles
  visible.forEach((bar, index) => {
    const x = plot.left + spacing * index + spacing / 2;
    const yOpen = priceToY(bar.open);
    const yClose = priceToY(bar.close);
    const yHigh = priceToY(bar.high);
    const yLow = priceToY(bar.low);
    const up = bar.close >= bar.open;
    const color = up ? bid : ask;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    if (bar.inProgress) ctx.globalAlpha = 0.55;
    ctx.beginPath();
    ctx.moveTo(x, yHigh); ctx.lineTo(x, yLow); ctx.stroke();
    const bodyTop = Math.min(yOpen, yClose);
    const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyWidth / 2, bodyTop, bodyWidth, bodyHeight);
    ctx.globalAlpha = 1;
  });

  // buff line overlay
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let started = false;
  visible.forEach((bar, index) => {
    if (bar.buff == null) return;
    const x = plot.left + spacing * index + spacing / 2;
    const y = priceToY(bar.buff);
    if (!started) { ctx.moveTo(x, y); started = true; }
    else ctx.lineTo(x, y);
  });
  if (started) ctx.stroke();
  ctx.lineWidth = 1;

  // position lines (entry / stop / target)
  if (pos) {
    const drawLevel = (price, color, label) => {
      const y = priceToY(price);
      ctx.strokeStyle = color;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(plot.left, y); ctx.lineTo(plot.right, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.textAlign = "left";
      ctx.fillText(label, plot.left + 4, y - 8);
    };
    drawLevel(pos.entry, text, `entry ${formatPrice(pos.entry)}`);
    drawLevel(pos.target, bid, `target ${formatPrice(pos.target)}`);
    drawLevel(pos.stop, ask, `stop ${formatPrice(pos.stop)}`);
  }

  // last close marker
  const last = visible[visible.length - 1];
  const lastY = priceToY(last.close);
  ctx.strokeStyle = text;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(plot.left, lastY); ctx.lineTo(plot.right, lastY); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = text;
  ctx.textAlign = "left";
  ctx.fillText(formatPrice(last.close), plot.right + 8, lastY);

  // axis time labels
  ctx.fillStyle = muted;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(formatTime(visible[0].bar_start).slice(11, 16), plot.left, height - 12);
  ctx.textAlign = "right";
  ctx.fillText(formatTime(last.bar_start).slice(11, 16), plot.right, height - 12);

  renderStrategySummary();
}

el.filter.addEventListener("input", renderOrderbooks);
el.refresh.addEventListener("click", loadOrderbooks);
el.themeToggle.addEventListener("click", () => {
  setTheme(document.body.dataset.theme === "dark" ? "light" : "dark");
});
el.loadEvents.addEventListener("click", loadEvents);
el.limit.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadEvents();
});
el.tabs.forEach((tab) => tab.addEventListener("click", () => setView(tab.dataset.view)));
el.replayDate.addEventListener("change", () => setReplayDate(el.replayDate.value));
el.replayLoad.addEventListener("click", () => loadReplayChunk());
el.replayNext.addEventListener("click", () => stepReplay(1));
el.replayPrev.addEventListener("click", () => stepReplay(-1));
el.replayOffset.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadReplayChunk();
});
el.chartDate.addEventListener("change", () => setChartDate(el.chartDate.value));
el.chartInterval.addEventListener("change", () => {
  stopChartPlayback();
  state.chart.candles = [];
  state.chart.tradeCount = 0;
  state.chart.lastTrade = null;
  state.chart.events = [];
  state.chart.index = -1;
  el.chartOffset.value = state.chart.offset || 0;
  renderChartEvent();
  drawCandles();
});
el.chartLoad.addEventListener("click", () => handleChartLoad());
el.chartStep.addEventListener("click", () => stepChart(1));
el.chartTrade.addEventListener("click", () => stepChartToNextTrade());
el.chartPlay.addEventListener("click", () => {
  if (state.chart.playing) {
    stopChartPlayback();
  } else {
    startChartPlayback();
  }
});
el.chartSlower.addEventListener("click", () => adjustChartSpeed(-1));
el.chartFaster.addEventListener("click", () => adjustChartSpeed(1));
el.chartOffset.addEventListener("keydown", (event) => {
  if (event.key === "Enter") handleChartLoad();
});
el.chartLimit.addEventListener("keydown", (event) => {
  if (event.key === "Enter") handleChartLoad();
});

el.strategyDate.addEventListener("change", () => setStrategyDate(el.strategyDate.value));
el.strategyLoad.addEventListener("click", () => loadStrategySession());
el.strategyStep.addEventListener("click", () => stepStrategy(1));
el.strategyNextBar.addEventListener("click", () => stepStrategyToNextBar());
el.strategyNextSignal.addEventListener("click", () => stepStrategyToNextSignal());
el.strategyPlay.addEventListener("click", () => {
  if (state.strategy.playing) stopStrategyPlayback();
  else startStrategyPlayback();
});
el.strategySlower.addEventListener("click", () => adjustStrategySpeed(-1));
el.strategyFaster.addEventListener("click", () => adjustStrategySpeed(1));

window.addEventListener("resize", () => {
  drawCandles();
  drawStrategyChart();
});

setTheme(preferredTheme());
async function initDashboard() {
  await loadReplayDates();
  await loadOrderbooks();
  updateChartSpeedControls();
  updateStrategySpeedControls();
}

initDashboard().catch((error) => {
  el.summary.textContent = error.message;
  el.selectedTitle.textContent = "Dashboard error";
});
