"use strict";

const elements = Object.fromEntries([
  "connection", "setup-notice", "state-warning", "reset-chat", "chat-empty", "chat-log", "chat-form",
  "message", "chat-error", "retry-notice", "chat-status", "send-message", "timer-count",
  "time-zone", "timers-title", "timer-list", "timers-empty", "timer-error", "timer-announcement",
  "timer-form", "timer-label", "timer-duration", "manual-retry-notice", "create-timer",
].map((id) => [id, document.getElementById(id)]));

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const timerNodes = new Map();
const timerActions = new Set();
let configured = false;
let online = false;
let chatBusy = false;
// Updated from the server so longer compound requests aren't abandoned early.
let chatTimeoutMs = 510000;
let timerBusy = false;
let retryChat = null;
let retryTimer = null;
let knownChatFailure = false;
let knownTimerFailure = false;
let serverOffset = 0;
let latestTimerSnapshot = 0;
let timerStateLoaded = false;
let timers = [];
let sessionId;
try { sessionId = localStorage.getItem("merlin-session-id"); } catch { /* Storage may be unavailable in a private browser. */ }
if (!/^[a-zA-Z0-9-]{1,100}$/.test(sessionId || "")) sessionId = crypto.randomUUID();
function persistSession() {
  try { localStorage.setItem("merlin-session-id", sessionId); } catch { /* This conversation still works for the current page. */ }
}
persistSession();
let memoryLab;

elements["time-zone"].textContent = `Your time zone: ${timeZone}`;

function textElement(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value;
  return node;
}

function showError(id, message) {
  elements[id].textContent = message || "";
  elements[id].hidden = !message;
}

async function request(path, body, timeoutMs = 120000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    let data;
    try { data = await response.json(); } catch {
      throw Object.assign(new Error("The server returned an unreadable response. The request may have run; check the timers before retrying."), { uncertain: true });
    }
    if (!response.ok) {
      throw Object.assign(new Error(data.error || `The request failed (${response.status}).`), { data, status: response.status });
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError" || error instanceof TypeError) {
      throw Object.assign(new Error("The connection was interrupted. The request may have run; check the timers before retrying."), { uncertain: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function updateChatControls() {
  const isRetry = retryChat && elements.message.value.trim() === retryChat.message;
  elements["send-message"].disabled = chatBusy || !configured || !online;
  elements["send-message"].textContent = chatBusy ? "Working…" : isRetry ? "Retry request" : "Send message";
  elements.message.readOnly = chatBusy;
  elements["reset-chat"].disabled = chatBusy || !online;
  elements["chat-form"].setAttribute("aria-busy", String(chatBusy));
  elements["chat-status"].textContent = chatBusy
    ? "Working on your request…"
    : !online ? "Waiting for the local server."
      : configured ? "Ready for your request." : "Add your Meta API key to enable chat.";
  elements["retry-notice"].hidden = !retryChat && !knownChatFailure;
  if (retryChat) {
    elements["retry-notice"].textContent = isRetry
      ? "Retry keeps the same request ID to help prevent duplicate actions. Your message is saved here for correction."
      : "Editing the message starts a new request. The previous request may already have acted; check the timers first.";
  } else if (knownChatFailure) {
    elements["retry-notice"].textContent = "Check the action results and timers before sending again; successful actions will not be undone. Sending again starts a new request.";
  }
}

function acceptState(data) {
  if (Object.hasOwn(data, "warning")) showError("state-warning", data.warning);
  const timestamp = Date.parse(data.server_time);
  if (Number.isFinite(timestamp) && timestamp >= latestTimerSnapshot) {
    // server_time is produced after tool/model work, so request duration is not clock skew.
    serverOffset = timestamp - Date.now();
    if (Array.isArray(data.timers)) {
      latestTimerSnapshot = timestamp;
      renderTimers(data.timers);
    }
  }
}

async function pollState() {
  try {
    const state = await request("/api/state", undefined, 8000);
    online = true;
    configured = state.configured === true;
    if (Number.isSafeInteger(state.chat_timeout_ms) && state.chat_timeout_ms > 0) {
      chatTimeoutMs = state.chat_timeout_ms;
    }
    showError("state-warning", state.warning);
    elements["setup-notice"].hidden = configured;
    elements.connection.dataset.state = "online";
    elements.connection.textContent = configured
      ? `Local server connected · ${state.model || "Meta configured"}`
      : "Local server connected · Meta key needed";
    acceptState(state);
  } catch {
    online = false;
    elements.connection.dataset.state = "offline";
    elements.connection.textContent = "Local server disconnected. Reconnecting…";
  } finally {
    updateChatControls();
    setTimeout(pollState, 1000);
  }
}

function renderTimers(nextTimers) {
  const previous = new Map(timers.map((timer) => [timer.id, timer]));
  const ids = new Set(nextTimers.map((timer) => timer.id));
  for (const [id, nodes] of timerNodes) {
    if (!ids.has(id)) {
      const hadFocus = nodes.root.contains(document.activeElement);
      nodes.root.remove();
      timerNodes.delete(id);
      if (hadFocus) elements["timers-title"].focus();
    }
  }
  const newlyCompleted = [];
  for (const timer of nextTimers) {
    let nodes = timerNodes.get(timer.id);
    if (!nodes) {
      const root = document.createElement("article");
      root.className = "timer";
      const heading = document.createElement("div");
      heading.className = "timer-heading";
      const label = textElement("h3", "", timer.label);
      const status = textElement("span", "timer-status", "");
      const remaining = textElement("p", "timer-remaining", "");
      remaining.setAttribute("aria-live", "off");
      const end = textElement("p", "timer-end", "");
      const action = textElement("button", "secondary", "");
      action.type = "button";
      action.addEventListener("click", () => changeTimer(timer.id));
      heading.append(label, status);
      root.append(heading, remaining, end, action);
      nodes = { root, label, status, remaining, end, action };
      timerNodes.set(timer.id, nodes);
      elements["timer-list"].append(root);
    }
    nodes.root.dataset.status = timer.status;
    nodes.label.textContent = timer.label;
    nodes.status.textContent = timer.status === "completed" ? "Finished" : timer.status === "cancelled" ? "Cancelled" : "Running";
    const actionName = timer.status === "running" ? "Cancel" : "Dismiss";
    nodes.action.textContent = timerActions.has(timer.id) ? "Updating…" : actionName;
    nodes.action.setAttribute("aria-label", `${actionName} ${timer.label} timer`);
    nodes.action.disabled = timerActions.has(timer.id);
    const zone = timer.time_zone || timeZone;
    const endDate = new Date(timer.ends_at);
    let endText = "";
    try {
      endText = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", timeZone: zone }).format(endDate);
    } catch { endText = timer.ends_at || "Unknown"; }
    nodes.end.textContent = `${timer.status === "running" ? "Ends" : "End time"} ${endText} · ${zone}`;
    if (timerStateLoaded && timer.status === "completed" && previous.get(timer.id)?.status !== "completed") newlyCompleted.push(timer.label);
  }
  timers = nextTimers;
  timerStateLoaded = true;
  elements["timers-empty"].hidden = nextTimers.length > 0;
  elements["timer-count"].textContent = `${nextTimers.filter((timer) => timer.status === "running").length} running`;
  if (newlyCompleted.length) elements["timer-announcement"].textContent = `${newlyCompleted.join(", ")} ${newlyCompleted.length === 1 ? "timer has" : "timers have"} finished.`;
  updateCountdowns();
}

function updateCountdowns() {
  const now = Date.now() + serverOffset;
  for (const timer of timers) {
    const nodes = timerNodes.get(timer.id);
    if (!nodes) continue;
    if (timer.status !== "running") {
      nodes.remaining.textContent = timer.status === "completed" ? "Time’s up" : "Stopped";
      continue;
    }
    const seconds = Math.max(0, Math.ceil((Date.parse(timer.ends_at) - now) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = String(seconds % 60).padStart(2, "0");
    nodes.remaining.textContent = hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
    if (seconds === 0) nodes.status.textContent = online ? "Confirming finish…" : "Awaiting server";
  }
}

async function changeTimer(id) {
  const timer = timers.find((item) => item.id === id);
  if (!timer || timerActions.has(id)) return;
  const action = timer.status === "running" ? "cancel" : "dismiss";
  timerActions.add(id);
  renderTimers(timers);
  showError("timer-error", "");
  try {
    const data = await request(`/api/timers/${encodeURIComponent(id)}/${action}`, {});
    acceptState(data);
  } catch (error) {
    if (error.data) acceptState(error.data);
    showError("timer-error", error.message);
  } finally {
    timerActions.delete(id);
    renderTimers(timers);
  }
}

function addChatEntry(role, content) {
  elements["chat-empty"].hidden = true;
  const entry = document.createElement("article");
  entry.className = "chat-entry";
  entry.dataset.role = role;
  entry.append(textElement("span", "chat-speaker", role === "user" ? "You" : "MERLIN"));
  entry.append(textElement("p", "message-body", content));
  elements["chat-log"].append(entry);
  return entry;
}

function renderReply(entry, data, error = "") {
  entry.dataset.state = error ? "error" : "complete";
  const body = entry.querySelector(".message-body");
  body.textContent = error || data.reply || "I couldn’t complete the reply. Check any action results below before trying again.";
  for (const existing of entry.querySelectorAll(":scope > .tool-results, :scope > .sources, :scope > .sources-label")) existing.remove();
  const actionNames = { create_timer: "Timer", cancel_timer: "Timer cancellation", list_timers: "Timer list", web_search: "Web search", spotify_control: "Spotify request", spotify_search: "Spotify search", spotify_playlists: "Spotify playlists", spotify_status: "Spotify player" };
  const actionFailures = {
    create_timer: "The timer could not be started.",
    cancel_timer: "The timer cancellation could not be completed.",
    list_timers: "I couldn’t check the timers.",
    web_search: "I couldn’t finish the web search.",
    spotify_control: "Spotify did not confirm the request. Check playback in the Spotify panel before trying again.",
    spotify_search: "I couldn’t retrieve the Spotify results. Check the Spotify panel.",
    spotify_playlists: "I couldn’t retrieve your Spotify playlists. Check the Spotify panel.",
    spotify_status: "I couldn’t check Spotify playback. Refresh the Spotify panel.",
  };
  const actionResults = (Array.isArray(data.tool_events) ? data.tool_events : []).filter((event) =>
    Object.hasOwn(actionNames, event.tool) && (error || !data.reply || event.status !== "completed"));
  // Successful replies already explain outcomes. Keep real action failures and
  // partial successes visible when reply delivery fails; diagnostics live below.
  if (actionResults.length) {
    const list = document.createElement("ul");
    list.className = "tool-results";
    list.setAttribute("aria-label", "Action results");
    for (const event of actionResults) {
      const item = document.createElement("li");
      const outcome = event.status === "completed" ? event.tool === "spotify_control" ? "Response received" : "Completed" : "Not completed";
      item.append(textElement("strong", "", `${actionNames[event.tool]} · ${outcome}`));
      const message = event.status === "completed" ? event.message : actionFailures[event.tool];
      if (message) item.append(document.createTextNode(` — ${message}`));
      list.append(item);
    }
    entry.append(list);
  }
  const sources = document.createElement("ul");
  sources.className = "sources";
  for (const source of Array.isArray(data.sources) ? data.sources : []) {
    try {
      const url = new URL(source.url);
      if (!["https:", "http:"].includes(url.protocol)) continue;
      const link = textElement("a", "", source.title || url.hostname);
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      const item = document.createElement("li");
      item.append(link);
      sources.append(item);
    } catch { /* Invalid source URLs are not interactive. */ }
  }
  if (sources.children.length) entry.append(textElement("p", "sources-label", "Sources (open in a new tab)"), sources);
  scrollChat();
}

function scrollChat() {
  const area = elements["chat-log"].parentElement;
  area.scrollTop = area.scrollHeight;
}

elements["chat-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = elements.message.value.trim();
  if (!message || chatBusy || !configured || !online) return;
  const attempt = retryChat?.message === message ? retryChat : { message, requestId: crypto.randomUUID() };
  if (!attempt.entry) {
    addChatEntry("user", message);
    attempt.entry = addChatEntry("assistant", "Working on your request…");
  }
  attempt.entry.dataset.state = "pending";
  attempt.entry.querySelector(".message-body").textContent = "Working on your request…";
  retryChat = null;
  knownChatFailure = false;
  chatBusy = true;
  showError("chat-error", "");
  updateChatControls();
  scrollChat();
  memoryLab?.begin(attempt.requestId, attempt.entry);
  let responseData;
  try {
    const data = await request("/api/chat", { message, time_zone: timeZone, session_id: sessionId, request_id: attempt.requestId }, chatTimeoutMs);
    responseData = data;
    acceptState(data);
    if (data.error) throw Object.assign(new Error(data.error), { data });
    renderReply(attempt.entry, data);
    elements.message.value = "";
  } catch (error) {
    responseData = error.data;
    retryChat = error.uncertain ? attempt : null;
    knownChatFailure = !error.uncertain;
    if (error.data) acceptState(error.data);
    renderReply(attempt.entry, error.data || {}, error.message);
    showError("chat-error", error.message);
  } finally {
    chatBusy = false;
    memoryLab?.finish(attempt.entry, responseData);
    window.dispatchEvent(new Event("merlin:chat-complete"));
    updateChatControls();
    elements.message.focus();
  }
});

elements.message.addEventListener("input", updateChatControls);
elements.message.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    elements["chat-form"].requestSubmit();
  }
});
for (const example of document.querySelectorAll("[data-prompt]")) {
  example.addEventListener("click", () => {
    if (chatBusy) return;
    elements.message.value = example.dataset.prompt;
    updateChatControls();
    elements.message.focus();
  });
}

function clearChatView() {
  elements["chat-log"].replaceChildren();
  elements["chat-empty"].hidden = false;
  elements.message.value = "";
  retryChat = null;
  knownChatFailure = false;
}

elements["reset-chat"].addEventListener("click", () => {
  if (chatBusy) return;
  sessionId = crypto.randomUUID();
  persistSession();
  clearChatView();
  updateChatControls();
  showError("chat-error", "");
  memoryLab?.newConversation();
  elements.message.focus();
});

elements["timer-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (timerBusy) return;
  const label = elements["timer-label"].value.trim();
  const duration = Number(elements["timer-duration"].value);
  if (!label || label.length > 80 || !Number.isSafeInteger(duration) || duration < 1 || duration > 604800) {
    showError("timer-error", "Enter a label of 1–80 characters and a whole number of seconds from 1 to 604,800.");
    return;
  }
  const attempt = retryTimer?.label === label && retryTimer.duration === duration
    ? retryTimer : { label, duration, requestId: crypto.randomUUID() };
  timerBusy = true;
  elements["create-timer"].disabled = true;
  elements["create-timer"].textContent = "Starting…";
  elements["timer-label"].readOnly = true;
  elements["timer-duration"].readOnly = true;
  showError("timer-error", "");
  elements["manual-retry-notice"].hidden = true;
  knownTimerFailure = false;
  try {
    const data = await request("/api/timers", { label, duration_seconds: duration, time_zone: timeZone, request_id: attempt.requestId });
    acceptState(data);
    retryTimer = null;
    elements["timer-label"].value = "";
    elements["timer-announcement"].textContent = `${label} timer started.`;
  } catch (error) {
    retryTimer = error.uncertain ? attempt : null;
    knownTimerFailure = !error.uncertain;
    if (error.data) acceptState(error.data);
    showError("timer-error", error.message);
  } finally {
    timerBusy = false;
    elements["create-timer"].disabled = false;
    elements["timer-label"].readOnly = false;
    elements["timer-duration"].readOnly = false;
    updateManualRetry();
  }
});

function updateManualRetry() {
  const sameRequest = retryTimer && retryTimer.label === elements["timer-label"].value.trim()
    && retryTimer.duration === Number(elements["timer-duration"].value);
  elements["create-timer"].textContent = sameRequest ? "Retry test timer" : "Start test timer";
  elements["manual-retry-notice"].hidden = !retryTimer && !knownTimerFailure;
  elements["manual-retry-notice"].textContent = retryTimer
    ? sameRequest
      ? "Retry uses the same request ID. Check existing timers if the previous result was uncertain."
      : "Changed details create a new timer. Check whether the previous timer already started."
    : "Check existing timers before starting another; successful actions will not be undone. Starting again sends a new request.";
}

elements["timer-label"].addEventListener("input", updateManualRetry);
elements["timer-duration"].addEventListener("input", updateManualRetry);
setInterval(updateCountdowns, 1000);
memoryLab = window.createMemoryLab({
  request,
  getSessionId: () => sessionId,
  isChatBusy: () => chatBusy,
  restoreConversation(messages) {
    if (chatBusy) return;
    const draft = elements.message.value;
    clearChatView();
    elements.message.value = draft;
    for (const message of messages) addChatEntry(message.role, message.text || message.content || "");
    updateChatControls();
    scrollChat();
  },
  async deleteConversation() {
    if (chatBusy) throw new Error("Wait for the current request to finish before deleting this conversation.");
    await request("/api/session/reset", { session_id: sessionId });
    clearChatView();
    updateChatControls();
  },
});
pollState();
