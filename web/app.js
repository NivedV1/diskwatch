"use strict";

const byId = (id) => document.getElementById(id);
const chart = byId("chart");
const canvas = byId("plot");
const context = canvas.getContext("2d");
const tooltip = byId("chart-tooltip");
const crosshair = byId("chart-crosshair");
const legend = byId("temperature-legend");
const stats = ["chart-min", "chart-average", "chart-max"];
const formats = {
  full: new Intl.DateTimeFormat(undefined, {dateStyle: "medium", timeStyle: "short"}),
  day: new Intl.DateTimeFormat(undefined, {month: "short", day: "numeric"}),
  hour: new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"}),
  number: new Intl.NumberFormat(undefined, {maximumFractionDigits: 1}),
};
const healthNames = {healthy: "Healthy", warning: "Attention", failed: "Failing", unknown: "Unknown"};
const readingNames = {partial: "Partial reading", standby: "Standby", offline: "Offline", unavailable: "Unavailable"};
const plotPriority = {unknown: 0, healthy: 1, warning: 2, failed: 3};
const linePatterns = [[], [6, 3], [2, 3], [9, 3, 2, 3]];
const metricLabels = {
  power_on_hours: ["Power-on hours", " h"],
  power_cycles: ["Power cycles", ""],
  reallocated_sectors: ["Reallocated sectors", ""],
  pending_sectors: ["Pending sectors", ""],
  uncorrectable_sectors: ["Uncorrectable sectors", ""],
  used_percent: ["Endurance used", "%"],
  spare_percent: ["Available spare", "%"],
  media_errors: ["Media errors", ""],
  unsafe_shutdowns: ["Unsafe shutdowns", ""],
  critical_warning: ["NVMe critical warning", ""],
};

const state = {
  dashboard: null,
  drive: null,
  days: 7,
  history: null,
  historyRequest: null,
  plot: null,
  chartMessage: "Waiting for drive readings.",
  layout: null,
  activePoint: -1,
  refreshing: false,
};

function node(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function temperature(value) {
  return value === null || value === undefined ? "—" : formats.number.format(value) + " °C";
}

function capacity(value) {
  if (!value) return "—";
  if (value >= 1e12) return formats.number.format(value / 1e12) + " TB";
  if (value >= 1e9) return formats.number.format(value / 1e9) + " GB";
  return formats.number.format(value / 1e6) + " MB";
}

function timestamp(value) {
  return formats.full.format(new Date(value * 1000));
}

function badge(drive) {
  const health = drive.health;
  const label = (health === "unknown" && readingNames[drive.reading]) || healthNames[health];
  const pill = node("span", "badge " + health);
  pill.append(node("i", "dot " + health), document.createTextNode(label));
  return pill;
}

function setNotice(message, caution = false) {
  const notice = byId("notice");
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle("caution", caution);
}

function collectorStatus(status, label) {
  const indicator = byId("collector-state");
  indicator.className = "collector-state " + status;
  indicator.lastElementChild.textContent = label;
}

function renderSummary(data) {
  const current = data.drives.filter((drive) => drive.reading !== "offline");
  const healthy = current.filter((drive) => drive.health === "healthy").length;
  const alerts = current.filter((drive) => drive.health === "warning" || drive.health === "failed").length;
  const unknown = current.length - healthy - alerts;
  const hottest = current.reduce((best, drive) => {
    if (drive.temperature === null) return best;
    return !best || drive.temperature > best.temperature ? drive : best;
  }, null);
  const types = new Map();
  current.forEach((drive) => types.set(drive.kind, (types.get(drive.kind) || 0) + 1));
  byId("drive-count").textContent = data.last_collection ? current.length : "—";
  byId("drive-caption").textContent = [...types].map(([type, n]) => n + " " + type).join(" · ") ||
    (data.last_collection ? "No drives in the latest collection" : "Waiting for a collection");
  byId("healthy-count").textContent = current.length ? healthy + " / " + current.length : "—";
  const healthCaption = [alerts ? alerts + " need attention" : "", unknown ? unknown + " unknown" : ""].filter(Boolean);
  byId("healthy-caption").textContent = healthCaption.join(" · ") ||
    (healthy ? "All drives healthy" : "No SMART status available");
  byId("hottest-temp").textContent = temperature(hottest?.temperature);
  byId("hottest-caption").textContent = hottest?.model || "No temperature available";
  byId("host-name").textContent = data.host;
  byId("host-name").title = data.host;

  if (data.demo) {
    collectorStatus("demo", "Demo data");
    setNotice("Example readings are shown in this preview.");
  } else if (data.issue) {
    collectorStatus("delayed", "Check collector");
    setNotice(data.issue, true);
  } else if (!data.last_collection) {
    collectorStatus("", "Awaiting collection");
    setNotice("The dashboard is waiting for its first SMART collection.");
  } else if (Date.now() / 1000 - data.last_collection > data.interval * 2.5) {
    collectorStatus("delayed", "Collection delayed");
    setNotice("The collector has missed its expected update. Values reflect the last collection.", true);
  } else {
    collectorStatus("live", "Collector active");
    setNotice("");
  }
  byId("last-collection").textContent = data.last_collection
    ? "Last collected " + timestamp(data.last_collection)
    : "Awaiting first collection";
}

function renderInventory() {
  const {drives} = state.dashboard;
  const body = byId("drive-rows");
  const focused = body.contains(document.activeElement) ? document.activeElement.dataset.drive : null;
  byId("inventory-count").textContent = drives.length + (drives.length === 1 ? " drive" : " drives");
  if (!drives.length) {
    const empty = node("td", "empty", "No drive readings are available yet.");
    empty.colSpan = 5;
    body.replaceChildren(node("tr"));
    body.firstElementChild.append(empty);
    return;
  }

  const rows = drives.map((drive) => {
    const selected = drive.drive_id === state.drive;
    const row = node("tr", selected ? "selected" : "");
    const first = node("td");
    const button = node("button", "drive-cell", drive.model);
    button.type = "button";
    button.dataset.drive = drive.drive_id;
    button.setAttribute("aria-pressed", String(selected));
    button.append(node("small", "", drive.path));
    first.append(button);
    const health = node("td");
    health.append(badge(drive));
    row.append(first, node("td", "", drive.kind), node("td", "", capacity(drive.capacity)),
      health, node("td", "", temperature(drive.temperature)));
    return row;
  });
  body.replaceChildren(...rows);
  if (focused) body.querySelector('[data-drive="' + focused + '"]')?.focus({preventScroll: true});
}

function renderDetails() {
  const container = byId("drive-details");
  const drive = state.dashboard.drives.find((entry) => entry.drive_id === state.drive);
  if (!drive) {
    container.replaceChildren(node("p", "empty", "Drive details will appear after collection."));
    return;
  }

  const icon = node("span", "stat-icon disk");
  icon.setAttribute("aria-hidden", "true");
  icon.append(node("i"));
  const title = node("div");
  title.append(node("strong", "", drive.model), node("small", "", [drive.kind, drive.path].join(" · ")));
  const heading = node("div", "drive-heading");
  heading.append(icon, title);

  const values = [
    ["SMART status", badge(drive)],
    ["Temperature", temperature(drive.temperature)],
    ["Capacity", capacity(drive.capacity)],
  ];
  for (const [key, [label, unit]] of Object.entries(metricLabels)) {
    if (drive.metrics[key] !== undefined && (key !== "critical_warning" || drive.metrics[key] > 0)) {
      values.push([label, formats.number.format(drive.metrics[key]) + unit]);
    }
  }
  const list = node("dl", "detail-data");
  for (const [label, value] of values) {
    const line = node("div");
    const field = node("dd");
    field.append(value);
    line.append(node("dt", "", label), field);
    list.append(line);
  }
  const note = drive.detail || ((drive.reading === "partial" && readingNames.partial) || "");
  container.replaceChildren(heading, list);
  if (note) container.append(node("p", "detail-note", note));
}

async function getJSON(path, signal) {
  const response = await fetch(path, {signal, cache: "no-store"});
  if (!response.ok) throw new Error("Could not load readings.");
  return response.json();
}

async function refresh() {
  if (state.refreshing) return;
  state.refreshing = true;
  byId("refresh").disabled = true;
  try {
    const data = await getJSON("/api/dashboard");
    state.dashboard = data;
    if (!data.drives.some((drive) => drive.drive_id === state.drive)) {
      state.drive = (data.drives.find((drive) => drive.reading === "ok") || data.drives[0])?.drive_id ?? null;
    }
    renderSummary(data);
    renderInventory();
    renderDetails();
    await loadHistory(false);
  } catch {
    collectorStatus("delayed", "Connection lost");
    setNotice("Diskwatch could not reach the local data service. Refresh to try again.", true);
  } finally {
    state.refreshing = false;
    byId("refresh").disabled = false;
  }
}

async function loadHistory(reset = true) {
  state.historyRequest?.abort();
  const request = new AbortController();
  state.historyRequest = request;
  if (reset || !state.drive || !state.history) {
    state.history = null;
    state.chartMessage = state.drive ? "Loading history…" : "No drive readings are available.";
    renderHistory();
  }
  if (!state.drive) return;
  try {
    const params = new URLSearchParams({all: "1", drive: state.drive, days: String(state.days)});
    const data = await getJSON("/api/history?" + params, request.signal);
    if (request.signal.aborted) return;
    state.history = data;
    state.chartMessage = Object.keys(data.series).length ? "No temperatures reported in this range." : "No samples in this range.";
  } catch (error) {
    if (request.signal.aborted) return;
    state.history = null;
    state.chartMessage = error.message;
  }
  renderHistory();
}

function chartSeries() {
  const drives = [...state.dashboard.drives];
  drives.sort((a, b) => a.path.localeCompare(b.path) || a.drive_id.localeCompare(b.drive_id));
  const modelCounts = new Map();
  for (const drive of drives) modelCounts.set(drive.model, (modelCounts.get(drive.model) || 0) + 1);
  return drives.flatMap((drive, slot) => {
    if (drive.reading === "offline" && drive.drive_id !== state.drive) return [];
    const label = modelCounts.get(drive.model) > 1 ? drive.model + " · " + drive.path : drive.model;
    const points = state.history?.series[drive.drive_id] ?? [];
    return [{drive, label, points, slot}];
  });
}

function seriesColor(slot, styles) {
  const color = styles.getPropertyValue("--chart-series-" + slot).trim();
  if (color) return color;
  const hue = Math.round(slot * 137.508 % 360);
  const lightness = document.documentElement.dataset.theme === "dark" ? 73 : 37;
  return `hsl(${hue}, 65%, ${lightness}%)`;
}

function seriesSwatch(item, styles) {
  const swatch = node("i", "series-swatch");
  swatch.setAttribute("aria-hidden", "true");
  swatch.dataset.pattern = String(item.slot % linePatterns.length);
  swatch.style.setProperty("--series-color", seriesColor(item.slot, styles));
  return swatch;
}

function renderLegend() {
  const series = state.plot?.series ?? [];
  const focused = legend.contains(document.activeElement) ? document.activeElement.dataset.drive : null;
  const styles = getComputedStyle(canvas);
  legend.hidden = !series.length;
  legend.replaceChildren(...series.map((item) => {
    const {drive, label} = item;
    const button = node("button", "series-button");
    button.type = "button";
    button.dataset.drive = drive.drive_id;
    button.title = "Show SMART history for " + drive.path;
    button.setAttribute("aria-pressed", String(drive.drive_id === state.drive));
    button.append(seriesSwatch(item, styles), node("span", "series-label", label));
    if (drive.reading === "offline") button.append(node("span", "series-offline", "Offline"));
    return button;
  }));
  if (focused) legend.querySelector('[data-drive="' + focused + '"]')?.focus({preventScroll: true});
}

function renderHistory() {
  const series = chartSeries();
  const readings = new Map();
  let min = Infinity, max = -Infinity, total = 0, count = 0;
  for (const {drive, points} of series) {
    for (const point of points) {
      const [time, value] = point;
      if (!readings.has(time)) readings.set(time, new Map());
      readings.get(time).set(drive.drive_id, point);
      if (!Number.isFinite(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
      total += value;
      count++;
    }
  }
  const times = [...readings.keys()].sort((a, b) => a - b);
  state.plot = {series, readings, times, lowest: count ? min : 20, highest: count ? max : 50};
  renderLegend();
  const selected = series.find(({drive}) => drive.drive_id === state.drive);
  byId("smart-history-label").textContent = selected ? "SMART history · " + selected.label : "SMART history";
  const valuesText = [count ? min : null, count ? total / count : null, count ? max : null].map(temperature);
  stats.forEach((id, index) => { byId(id).textContent = valuesText[index]; });
  const empty = byId("chart-empty");
  empty.hidden = count > 0;
  empty.textContent = state.chartMessage;
  empty.classList.toggle("chart-has-status", Boolean(times.length));
  chart.tabIndex = times.length ? 0 : -1;
  canvas.setAttribute("aria-label", count
    ? "Drive temperature comparison. Range " + valuesText[0] + " to " + valuesText[2] + ". Use arrow keys on the chart to inspect readings."
    : state.chartMessage);
  drawChart();
}

function drawChart() {
  hideTooltip();
  const {width, height} = canvas.getBoundingClientRect();
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  if (!width || !height) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const timeline = state.history;
  if (!timeline || !state.plot) {
    state.layout = null;
    return;
  }
  const {series, lowest, highest} = state.plot;
  const left = 40, right = width - 9, top = 12, bottom = height - 56;
  const statusY = height - 43;
  const interval = state.dashboard.interval;
  const x = (time) => left + (time - timeline.from) * (right - left) / (timeline.to - timeline.from);
  const step = highest - lowest > 30 ? 10 : 5;
  const ceiling = Math.ceil((highest + step / 3) / step) * step;
  const floor = Math.min(ceiling - step * 3, Math.floor((lowest - step / 3) / step) * step);
  const y = (value) => bottom - (value - floor) * (bottom - top) / (ceiling - floor);
  state.layout = {left, right, width, x};
  const styles = getComputedStyle(canvas);
  const color = (name) => styles.getPropertyValue("--chart-" + name).trim();
  const axis = color("axis");
  const grid = color("grid");
  context.font = "12px system-ui, sans-serif";
  context.textBaseline = "middle";
  context.textAlign = "right";
  for (let value = floor; value <= ceiling; value += step) {
    context.fillStyle = axis;
    context.fillText(value + "°", left - 7, y(value));
    context.strokeStyle = grid;
    context.beginPath();
    context.moveTo(left, y(value) + .5);
    context.lineTo(right, y(value) + .5);
    context.stroke();
  }

  context.lineWidth = 1.7;
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const {points, slot} of series) {
    context.strokeStyle = seriesColor(slot, styles);
    context.setLineDash(linePatterns[slot % linePatterns.length]);
    context.beginPath();
    let previous = null;
    let single = null;
    for (const [time, value] of points) {
      if (value === null || previous === null || time - previous > interval * 2.5) {
        if (single) context.lineTo(single[0] + .01, single[1]);
        single = value === null ? null : [x(time), y(value)];
        if (single) context.moveTo(...single);
      } else {
        context.lineTo(x(time), y(value));
        single = null;
      }
      previous = value === null ? null : time;
    }
    if (single) context.lineTo(single[0] + .01, single[1]);
    context.stroke();
  }

  const columns = new Uint8Array(Math.ceil(right - left));
  const smart = state.history.series[state.drive] ?? [];
  smart.forEach((point, index) => {
    const start = Math.max(0, Math.floor(x(point[0]) - left));
    const next = smart[index + 1]?.[0] ?? timeline.to;
    const end = Math.max(start + 1, Math.ceil(x(Math.min(next, point[0] + interval)) - left));
    for (let col = start; col < Math.min(end, columns.length); col++) {
      columns[col] = Math.max(columns[col], plotPriority[point[2]]);
    }
  });
  const plotColors = ["unknown", "healthy", "warning", "failed"].map(color);
  for (let col = 0; col < columns.length; col++) {
    context.fillStyle = plotColors[columns[col]];
    context.fillRect(left + col, statusY, 1, 8);
  }

  const tickCount = width > 500 ? 6 : width > 300 ? 4 : 3;
  for (let tick = 0; tick < tickCount; tick++) {
    const progress = tick / (tickCount - 1);
    const time = timeline.from + (timeline.to - timeline.from) * progress;
    const formatter = state.days === 1 ? formats.hour : formats.day;
    context.textAlign = tick === 0 ? "left" : tick === tickCount - 1 ? "right" : "center";
    context.fillStyle = axis;
    context.fillText(formatter.format(time * 1000), x(time), height - 16);
  }
}

function tooltipAt(pointIndex) {
  if (state.activePoint === pointIndex) return;
  state.activePoint = pointIndex;
  const {times, readings, series} = state.plot;
  const time = times[pointIndex];
  const atTime = readings.get(time);
  const styles = getComputedStyle(canvas);
  const rows = series.map((item) => {
    const row = node("div", "temperature-tooltip-row");
    row.append(seriesSwatch(item, styles), node("span", "series-label", item.label),
      node("span", "tooltip-reading", temperature(atTime.get(item.drive.drive_id)?.[1])));
    return row;
  });
  const selected = atTime.get(state.drive);
  const smart = selected
    ? [healthNames[selected[2]], readingNames[selected[3]]].filter(Boolean).join(" · ")
    : "No reading";
  tooltip.replaceChildren(node("strong", "", timestamp(time)), ...rows,
    node("span", "tooltip-smart", "Selected drive SMART · " + smart));
  tooltip.hidden = false;
  crosshair.hidden = false;
  const x = state.layout.x(time);
  crosshair.style.left = x + "px";
  tooltip.style.left = Math.max(3, Math.min(state.layout.width - tooltip.offsetWidth - 3, x + 9)) + "px";
}

function hideTooltip() {
  tooltip.hidden = true;
  crosshair.hidden = true;
  state.activePoint = -1;
}

chart.addEventListener("pointermove", (event) => {
  const times = state.plot?.times;
  const layout = state.layout;
  if (!times?.length || !layout) return;
  const localX = event.clientX - chart.getBoundingClientRect().left;
  if (localX < layout.left || localX > layout.right) {
    hideTooltip();
    return;
  }
  const time = state.history.from + (state.history.to - state.history.from) *
    (localX - layout.left) / (layout.right - layout.left);
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo && time - times[lo - 1] < Math.abs(times[lo] - time)) lo--;
  if (Math.abs(times[lo] - time) <= state.dashboard.interval * 1.5) tooltipAt(lo);
  else hideTooltip();
});
chart.addEventListener("pointerleave", hideTooltip);
chart.addEventListener("blur", hideTooltip);
chart.addEventListener("keydown", (event) => {
  const last = (state.plot?.times.length ?? 0) - 1;
  if (last < 0 || !state.layout) return;
  if (event.key === "Escape") {
    hideTooltip();
    return;
  }
  const current = state.activePoint < 0 ? last : state.activePoint;
  const target = {
    ArrowLeft: Math.max(0, current - 1), ArrowRight: Math.min(last, current + 1), Home: 0, End: last,
  }[event.key];
  if (target === undefined) return;
  event.preventDefault();
  tooltipAt(target);
});

new ResizeObserver(drawChart).observe(chart);
document.addEventListener("diskwatch-theme-change", () => {
  renderLegend();
  drawChart();
});
byId("refresh").addEventListener("click", refresh);
function selectDrive(event) {
  const button = event.target.closest("button[data-drive]");
  if (!button || button.dataset.drive === state.drive) return;
  state.drive = button.dataset.drive;
  renderInventory();
  renderDetails();
  renderHistory();
  const selected = state.dashboard.drives.find((drive) => drive.drive_id === state.drive);
  if (selected?.reading === "offline" && !state.history?.series[state.drive]) loadHistory(false);
  if (event.currentTarget !== legend && chart.getBoundingClientRect().bottom < 0) {
    byId("history-title").scrollIntoView({block: "start"});
  }
}
legend.addEventListener("click", selectDrive);
byId("drive-rows").addEventListener("click", selectDrive);
const ranges = [...document.querySelectorAll("[data-days]")];
for (const button of ranges) {
  button.addEventListener("click", () => {
    state.days = Number(button.dataset.days);
    ranges.forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
    loadHistory();
  });
}
const nav = [...document.querySelectorAll(".nav-link")];
window.addEventListener("hashchange", updateNavigation);
function updateNavigation() {
  const section = window.location.hash === "#drives" ? "#drives" : "#overview";
  for (const link of nav) {
    const active = link.hash === section;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}

updateNavigation();
refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
