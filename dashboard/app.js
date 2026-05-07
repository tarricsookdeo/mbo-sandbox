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
};

const F_LAST = 128;
const BOOK_LEVEL_LIMIT = 100;
const CHART_VISIBLE_CANDLES = 90;
const CHART_SPEEDS = [
  { label: "0.25x", delay: 240 },
  { label: "0.5x", delay: 120 },
  { label: "1x", delay: 60 },
  { label: "2x", delay: 30 },
  { label: "4x", delay: 12 },
  { label: "8x", delay: 1 },
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
  el.replayLoad.disabled = true;
  el.chartLoad.disabled = true;
  el.replayDate.innerHTML = `<option value="">Loading</option>`;
  el.chartDate.innerHTML = `<option value="">Loading</option>`;
  const payload = await fetchJson("/api/replay-dates");
  state.replay.dates = payload.dates || [];
  state.chart.dates = state.replay.dates;
  renderReplayDates();
  renderChartDates();
  el.replayLoad.disabled = false;
  el.chartLoad.disabled = false;
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
window.addEventListener("resize", drawCandles);

setTheme(preferredTheme());
async function initDashboard() {
  await loadReplayDates();
  await loadOrderbooks();
  updateChartSpeedControls();
}

initDashboard().catch((error) => {
  el.summary.textContent = error.message;
  el.selectedTitle.textContent = "Dashboard error";
});
