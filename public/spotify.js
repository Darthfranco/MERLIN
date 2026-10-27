"use strict";

(() => {
  const $ = name => document.getElementById(`spotify-${name}`);
  const panel = $("panel");
  let state = { configured: false, connected: false, devices: [], playback: null };
  let busy = false;
  let configDirty = false;
  let refreshQueued = false;
  let pendingControl = null;
  let resultsSignature = "[]";

  function text(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = content;
    return node;
  }

  function errorMessage(message = "") {
    $("error").textContent = message;
    $("error").hidden = !message;
  }

  function feedback(message = "") { $("feedback").textContent = message; }

  function spotifyUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "open.spotify.com" && !url.username && !url.password && !url.port
        && /^\/(track|album|artist|playlist)\/[a-zA-Z0-9]+\/?$/.test(url.pathname) ? url.href : null;
    } catch { return null; }
  }

  function validUri(value) { return typeof value === "string" && /^spotify:(track|album|artist|playlist):[a-zA-Z0-9]+$/.test(value); }
  function selectedDevice() { return state.devices.find(device => device.id === $("device").value && !device.is_restricted); }
  function artists(value) { return Array.isArray(value) ? value.filter(item => typeof item === "string").join(", ") : ""; }

  async function request(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
      let data;
      try { data = await response.json(); }
      catch { throw Object.assign(new Error("Spotify’s response could not be read. Refresh to check its current state."), { uncertain: true }); }
      if (!response.ok) throw Object.assign(new Error(data.error || "Spotify could not complete the request. Refresh and try again."), { status: response.status });
      return data;
    } catch (error) {
      if (error.name === "AbortError" || error instanceof TypeError) {
        throw Object.assign(new Error("The connection was interrupted. Check Spotify before retrying; an action may already have happened."), { uncertain: true });
      }
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function syncControls() {
    const device = selectedDevice();
    const canControl = state.connected && Boolean(device);
    const volume = $("volume").value === "" ? NaN : Number($("volume").value);
    const hasVolume = canControl && device.supports_volume !== false;
    $("refresh").disabled = busy;
    $("connect").disabled = busy || !state.configured || state.connected;
    $("save-config").disabled = busy || !$("client-id").value.trim();
    $("client-id").readOnly = busy;
    $("copy-redirect").disabled = busy || !$("redirect").value;
    $("disconnect").disabled = busy || !state.connected;
    $("device").disabled = busy || !state.connected || !state.devices.length;
    for (const name of ["transfer", "previous", "play-pause", "next"]) $(name).disabled = busy || !canControl;
    $("volume").disabled = busy || !hasVolume;
    $("set-volume").disabled = busy || !hasVolume || !Number.isInteger(volume) || volume < 0 || volume > 100;
    $("volume-help").textContent = device?.supports_volume === false
      ? "This device does not support remote volume changes. Adjust volume in its Spotify app."
      : "Volume depends on the selected device’s support.";
    for (const name of ["shuffle", "repeat"]) {
      $(name).disabled = busy || !canControl;
      $(`set-${name}`).disabled = busy || !canControl || !$(name).value;
    }
    for (const name of ["search", "playlists", "query", "search-type"]) $(name).disabled = busy || !state.connected;
    for (const button of $("results").querySelectorAll("button")) button.disabled = busy || !canControl;
    $("retry").hidden = !pendingControl;
    $("retry").disabled = busy;
    const isPlayingHere = state.playback?.is_playing && state.playback?.device?.id === device?.id;
    $("play-pause").textContent = isPlayingHere ? "Pause" : "Play";
    panel.setAttribute("aria-busy", String(busy));
  }

  function updateVolume() {
    const value = selectedDevice()?.volume_percent;
    $("volume").value = Number.isInteger(value) && value >= 0 && value <= 100 ? String(value) : "";
  }

  function render() {
    $("status").textContent = state.connected ? "Connected to Spotify"
      : state.configured ? "Ready to connect your Spotify account" : "Add your app’s public client ID to connect";
    $("connect-view").hidden = state.connected;
    $("connected-view").hidden = !state.connected;
    const selected = $("device").value;
    $("device").replaceChildren(new Option("Choose a device", ""));
    for (const device of state.devices) {
      if (typeof device.id !== "string" || !device.id) continue;
      const option = new Option(`${device.name || "Spotify device"}${device.is_restricted ? " (unavailable)" : device.is_active ? " (active)" : ""}`, device.id);
      option.disabled = device.is_restricted === true;
      $("device").append(option);
    }
    const previous = state.devices.find(device => device.id === selected && !device.is_restricted);
    const active = state.devices.find(device => device.is_active && !device.is_restricted);
    $("device").value = previous?.id || active?.id || "";
    $("device-help").textContent = state.devices.some(device => !device.is_restricted)
      ? "Selecting a device does not start playback. Use device transfers playback without starting it."
      : "No available device. Open Spotify on your phone or computer, then select Refresh.";
    if (document.activeElement !== $("volume")) updateVolume();
    const playback = state.playback;
    const track = playback?.track;
    $("track-name").textContent = track?.name || (playback ? "Spotify playback" : "Nothing playing");
    $("track-artists").textContent = artists(track?.artists);
    $("playback-state").textContent = playback
      ? `${playback.is_playing ? "Playing" : "Paused"}${playback.device?.name ? ` on ${playback.device.name}` : ""}`
      : "Choose music below, or start it in Spotify and refresh.";
    const url = spotifyUrl(track?.url);
    $("track-link").hidden = !url;
    if (url) $("track-link").href = url;
    else $("track-link").removeAttribute("href");
    syncControls();
  }

  function accept(data) {
    state = {
      ...state,
      ...(typeof data.configured === "boolean" ? { configured: data.configured } : {}),
      ...(typeof data.connected === "boolean" ? { connected: data.connected } : {}),
      ...(Array.isArray(data.devices) ? { devices: data.devices } : {}),
      ...(Object.hasOwn(data, "playback") ? { playback: data.playback } : {}),
    };
    if (!state.connected) {
      state.devices = [];
      state.playback = null;
      $("results").replaceChildren();
      $("results-area").hidden = true;
      resultsSignature = "[]";
      pendingControl = null;
    }
    render();
  }

  async function loadStatus() {
    const data = await request("/api/spotify/status");
    $("redirect").value = typeof data.redirect_uri === "string" ? data.redirect_uri : "";
    if (!configDirty) $("client-id").value = typeof data.client_id === "string" ? data.client_id : "";
    accept(data);
  }

  async function loadSnapshot() {
    const data = await request("/api/spotify?refresh=1");
    accept(data);
    if (state.connected && Array.isArray(data.results) && JSON.stringify(data.results) !== resultsSignature) {
      renderResults(data.results, "Spotify results", "No recent selections. Search Spotify or load your playlists.");
    }
    if (typeof data.notice === "string" && data.notice) {
      errorMessage(data.notice);
      $("track-name").textContent = "Playback unavailable";
      $("playback-state").textContent = "Spotify’s current playback could not be checked. Try Refresh again.";
    }
  }

  async function perform(message, operation, onError) {
    if (busy) return;
    busy = true;
    errorMessage();
    feedback(message);
    syncControls();
    try { await operation(); }
    catch (error) {
      onError?.(error);
      feedback();
      errorMessage(error.message || "Spotify could not complete the request.");
    } finally {
      busy = false;
      syncControls();
      if (refreshQueued) { refreshQueued = false; void refresh(); }
    }
  }

  async function refresh() {
    if (busy) { refreshQueued = true; return; }
    await perform("Refreshing Spotify…", async () => {
      await loadStatus();
      if (state.connected) await loadSnapshot();
      feedback();
    });
  }

  async function executeControl(payload) {
    await perform("Sending your request to Spotify…", async () => {
      pendingControl = null;
      const result = await request("/api/spotify/control", payload);
      feedback(result.status === "choice_required"
        ? "Choose an item or device below, then try again. No playback change was made."
        : "Spotify accepted the request. The playback display shows its latest reported state.");
      try { await loadSnapshot(); }
      catch { errorMessage("The request was accepted, but playback could not be refreshed. Select Refresh to check Spotify."); }
    }, error => { if (error.uncertain) pendingControl = payload; });
  }

  function control(action, values = {}) {
    if (busy || !state.connected) return;
    const device = selectedDevice();
    if (!device) { errorMessage("Choose an available playback device first."); return; }
    void executeControl({ request_id: crypto.randomUUID(), action, device_id: device.id, ...values });
  }

  function renderResults(items, title, emptyMessage) {
    resultsSignature = JSON.stringify(Array.isArray(items) ? items : []);
    $("results-title").textContent = title;
    $("results-area").hidden = false;
    $("results").replaceChildren();
    for (const item of Array.isArray(items) ? items : []) {
      const row = text("li", "spotify-result", "");
      const name = typeof item.name === "string" ? item.name : "Untitled Spotify item";
      row.append(text("h4", "", name));
      const detail = [item.type, artists(item.artists)].filter(Boolean).join(" · ");
      if (detail) row.append(text("p", "help", detail));
      const url = spotifyUrl(item.url);
      if (url) {
        const link = text("a", "", "Open in Spotify");
        Object.assign(link, { href: url, target: "_blank", rel: "noopener noreferrer" });
        row.append(link);
      }
      if (validUri(item.uri)) {
        const actions = text("div", "spotify-result-actions", "");
        for (const action of item.type === "track" ? ["play", "queue"] : ["play"]) {
          const label = action === "play" ? "Play" : "Add to queue";
          const button = text("button", action === "queue" ? "secondary" : "", label);
          button.type = "button";
          button.setAttribute("aria-label", `${label}: ${name}`);
          button.addEventListener("click", () => control(action, { uri: item.uri }));
          actions.append(button);
        }
        row.append(actions);
      }
      $("results").append(row);
    }
    $("results-empty").hidden = $("results").children.length > 0;
    $("results-empty").textContent = emptyMessage;
    syncControls();
  }

  $("refresh").addEventListener("click", () => void refresh());
  $("client-id").addEventListener("input", () => { configDirty = true; syncControls(); });
  $("config-form").addEventListener("submit", async event => {
    event.preventDefault();
    await perform("Saving the Spotify app connection…", async () => {
      await request("/api/spotify/config", { client_id: $("client-id").value.trim() });
      configDirty = false;
      await loadStatus();
      $("setup").open = false;
      feedback("Client ID saved. Connect your Spotify account to continue.");
    });
    if (state.configured && !state.connected && !$("setup").open) $("connect").focus();
  });
  $("copy-redirect").addEventListener("click", async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText($("redirect").value);
      feedback("Redirect URI copied.");
    } catch {
      $("redirect").focus(); $("redirect").select();
      feedback("The redirect URI is selected. Copy it with your keyboard or touch menu.");
    }
  });
  $("connect").addEventListener("click", () => void perform("Opening Spotify’s sign-in page…", async () => {
    const data = await request("/api/spotify/connect", {});
    const url = new URL(data.url);
    if (url.protocol !== "https:" || url.hostname !== "accounts.spotify.com" || url.pathname !== "/authorize" || url.username || url.password || url.port) {
      throw new Error("The Spotify sign-in link was invalid. Refresh and try connecting again.");
    }
    window.location.assign(url.href);
  }));
  $("disconnect").addEventListener("click", async () => {
    await perform("Disconnecting Spotify…", async () => {
      await request("/api/spotify/disconnect", {});
      await loadStatus();
      feedback("Spotify is disconnected from MERLIN.");
    });
    if (!state.connected) $("connect").focus();
  });
  $("device").addEventListener("change", () => { updateVolume(); syncControls(); });
  $("transfer").addEventListener("click", () => control("transfer"));
  $("previous").addEventListener("click", () => control("previous"));
  $("next").addEventListener("click", () => control("next"));
  $("play-pause").addEventListener("click", () => {
    const isPlayingHere = state.playback?.is_playing && state.playback?.device?.id === selectedDevice()?.id;
    control(isPlayingHere ? "pause" : "play");
  });
  $("volume").addEventListener("input", syncControls);
  $("volume-form").addEventListener("submit", event => { event.preventDefault(); control("volume", { volume_percent: Number($("volume").value) }); });
  for (const name of ["shuffle", "repeat"]) {
    $(name).addEventListener("change", syncControls);
    $(`${name}-form`).addEventListener("submit", event => {
      event.preventDefault();
      if (!$(name).value) return;
      control(name, { state: name === "shuffle" ? $(name).value === "true" : $(name).value });
    });
  }
  $("retry").addEventListener("click", () => { if (pendingControl) void executeControl(pendingControl); });
  $("search-form").addEventListener("submit", event => {
    event.preventDefault();
    const query = $("query").value.trim();
    if (!query || !state.connected) return;
    void perform("Searching Spotify…", async () => {
      const data = await request("/api/spotify/search", { query, type: $("search-type").value });
      renderResults(data.results, "Search results", "No matches. Try a different title or search type.");
      feedback(`${$("results").children.length} results from Spotify.`);
    });
  });
  $("playlists").addEventListener("click", () => void perform("Loading your playlists…", async () => {
    const data = await request("/api/spotify/playlists", {});
    renderResults(data.results, "My playlists", "Spotify returned no playlists for this account.");
    feedback(`${$("results").children.length} playlists from Spotify.`);
  }));
  window.addEventListener("merlin:chat-complete", () => { if (state.connected) void refresh(); });

  const returnUrl = new URL(window.location.href);
  const connectionResult = returnUrl.searchParams.get("spotify");
  if (returnUrl.searchParams.has("spotify")) {
    returnUrl.searchParams.delete("spotify");
    window.history.replaceState(null, "", `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`);
  }
  void refresh().then(() => {
    if (connectionResult === "connected" && state.connected) feedback("Spotify is connected. Choose a device and music when you’re ready.");
    else if (connectionResult === "connected") errorMessage("Spotify returned to MERLIN, but the connection could not be verified. Select Refresh to check it.");
    else if (connectionResult === "cancelled") feedback("Spotify sign-in was cancelled. You can connect again when you’re ready.");
    else if (connectionResult === "error") errorMessage("Spotify could not connect. Review app setup and try Connect Spotify again.");
  });
})();
