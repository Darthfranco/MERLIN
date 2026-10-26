"use strict";

// A local inspection surface: all displayed records come from the server.
window.createMemoryLab = function createMemoryLab({ request, getSessionId, isChatBusy, restoreConversation, deleteConversation }) {
  const $ = (id) => document.getElementById(id);
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let snapshot = null;
  let refreshing = false;
  let refreshAgain = false;
  let refreshTimer;
  let restoring = true;
  let activeTrace = null;
  let traceTimer;
  const listSignatures = new Map();
  const categories = ["conversation", "facts", "rules", "documents", "routines"];

  function feedback(message, isError = false) {
    $("memory-error").hidden = !isError;
    $("memory-error").textContent = isError ? message : "";
    $("memory-feedback").textContent = isError ? "" : message;
  }

  function activateTab(name, moveFocus = false) {
    for (const category of categories) {
      const active = category === name;
      $("tab-" + category).setAttribute("aria-selected", String(active));
      $("tab-" + category).tabIndex = active ? 0 : -1;
      $("panel-" + category).hidden = !active;
    }
    if (moveFocus) $("tab-" + name).focus();
  }

  for (const category of categories) {
    const tab = $("tab-" + category);
    tab.addEventListener("click", () => activateTab(category));
    tab.addEventListener("keydown", (event) => {
      let index = categories.indexOf(category);
      if (event.key === "ArrowRight") index = (index + 1) % categories.length;
      else if (event.key === "ArrowLeft") index = (index - 1 + categories.length) % categories.length;
      else if (event.key === "Home") index = 0;
      else if (event.key === "End") index = categories.length - 1;
      else return;
      event.preventDefault();
      activateTab(categories[index], true);
    });
  }

  function when(value) {
    if (!value) return "";
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
  }

  function detail(title, value, key) {
    const node = make("details", "record-detail");
    if (key) node.dataset.detail = key;
    node.append(make("summary", "", title));
    node.append(make("pre", "raw-record", typeof value === "string" ? value : JSON.stringify(value, null, 2)));
    return node;
  }

  function sourceDetail(item) {
    const evidence = {};
    for (const field of ["id", "subject", "kind", "status", "source_id", "source_quote", "source", "original", "explanation", "reason", "created_at", "updated_at", "supersedes"]) {
      if (item[field] !== undefined) evidence[field] = item[field];
    }
    return detail("Source and interpretation · raw testing record", evidence, `${item.id}-source`);
  }

  function action(label, callback) {
    const button = make("button", "secondary", label);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try { await callback(); } catch (error) { feedback(error.message, true); }
      finally { if (button.isConnected) button.disabled = false; }
    });
    return button;
  }

  async function mutate(path, body, message) {
    await request(path, body, 15000);
    // Rebuild the visible transcript from retained records after invalidation, so
    // deleted source text and stale trace details don't linger in the browser.
    if (["/api/memory/delete", "/api/memory/resolve", "/api/memory/clear", "/api/routines/delete"].includes(path)
      || (body.id && ["/api/memory/fact", "/api/documents", "/api/routines"].includes(path))) restoring = true;
    feedback(message);
    await refresh();
  }

  function deleteAction(collection, item) {
    return action("Delete", async () => {
      await mutate("/api/memory/delete", { collection, id: item.id }, "Memory deleted. Its related recall records were invalidated.");
    });
  }

  function renderList(id, items, renderer, emptyText) {
    const signature = JSON.stringify(items);
    if (listSignatures.get(id) === signature) return;
    listSignatures.set(id, signature);
    const container = $(id);
    const open = new Set([...container.querySelectorAll("details[open][data-detail]")].map((item) => item.dataset.detail));
    const hadFocus = container.contains(document.activeElement);
    container.replaceChildren(...(items.length ? items.map(renderer) : [make("p", "memory-empty", emptyText)]));
    for (const item of container.querySelectorAll("details[data-detail]")) item.open = open.has(item.dataset.detail);
    if (hadFocus) container.closest("[role=tabpanel]")?.focus({ preventScroll: true });
  }

  function factRow(item) {
    const row = make("article", "memory-record");
    const replaced = item.status === "superseded";
    row.append(make("p", "record-kind", (item.kind === "guidance" ? "Guidance · not code-enforced" : `${item.kind || "Fact"} · ${item.subject || "household"}`) + (replaced ? " · replaced" : "")));
    row.append(make("p", "record-content", item.content));
    if (replaced) row.append(make("p", "help", "Replaced by a newer memory. This record is not used for recall."));
    row.append(sourceDetail(item));
    const actions = make("div", "record-actions");
    if (!replaced) actions.append(action("Edit", () => {
      $("fact-id").value = item.id;
      $("fact-content").value = item.content;
      $("fact-subject").value = item.subject || "household";
      $("fact-kind").value = item.kind || "fact";
      $("fact-editor").open = true;
      $("fact-content").focus();
    }));
    actions.append(deleteAction("facts", item));
    row.append(actions);
    return row;
  }

  function ruleRow(item) {
    const row = make("article", "memory-record");
    row.append(make("p", "record-kind", `${String(item.kind).replaceAll("_", " ")} · ${item.scope || "assistant_reply"}`));
    row.append(make("p", "record-content", item.explanation || item.original || String(item.value)));
    row.append(make("p", "help", `Value: ${typeof item.value === "object" ? JSON.stringify(item.value) : item.value} · ${item.status || "active"}`));
    row.append(sourceDetail(item), detail("Compiled rule · raw testing record", item, `${item.id}-compiled`));
    const actions = make("div", "record-actions");
    actions.append(deleteAction("rules", item));
    row.append(actions);
    return row;
  }

  function conversationRow(item) {
    const row = make("article", "memory-record");
    row.append(make("p", "record-kind", `${item.role === "user" ? "You" : "MERLIN"} · ${when(item.created_at)}`));
    row.append(make("p", "record-content", item.text || item.content || ""));
    row.append(detail("Message identifiers · raw testing record", { id: item.id, session_id: item.session_id, request_id: item.request_id }, `${item.id}-message`));
    return row;
  }

  function documentRow(item) {
    const row = make("article", "memory-record");
    row.append(make("h3", "", item.title), make("p", "help", item.description || "No catalog description."));
    const size = Number.isFinite(item.char_count) ? `${item.char_count.toLocaleString()} characters` : "size unavailable";
    row.append(make("p", "record-kind", `Version ${item.version || 1} · ${size}`));
    row.append(detail("Catalog record · raw testing record", item, `${item.id}-catalog`));
    const actions = make("div", "record-actions");
    actions.append(action("Read / edit", async () => {
      const response = await request(`/api/documents/${encodeURIComponent(item.id)}`, undefined, 10000);
      const document = response.document || response;
      $("document-id").value = document.id || item.id;
      $("document-title").value = document.title || item.title;
      $("document-description").value = document.description || "";
      $("document-content").value = document.content || "";
      $("document-file").value = "";
      $("document-editor").open = true;
      $("document-content").focus();
    }), deleteAction("documents", item));
    row.append(actions);
    return row;
  }

  function renderConflicts(conflicts, rules) {
    const container = $("memory-conflicts");
    const signature = JSON.stringify({ conflicts, rules });
    if (listSignatures.get("conflicts") === signature) return;
    listSignatures.set("conflicts", signature);
    container.hidden = !conflicts.length;
    container.replaceChildren();
    if (!conflicts.length) return;
    container.append(make("h3", "", `${conflicts.length} unresolved ${conflicts.length === 1 ? "conflict" : "conflicts"}`));
    container.append(make("p", "help", "MERLIN will ask when a request is affected. You can resolve the conflict here now by choosing which rule to keep."));
    for (const conflict of conflicts) {
      const block = make("div", "conflict-record");
      block.append(make("p", "", conflict.reason || conflict.key));
      const ids = conflict.rule_ids || [];
      for (const id of ids) {
        const rule = rules.find((item) => item.id === id);
        if (!rule) continue;
        const option = make("div", "conflict-option");
        option.append(make("p", "", rule.original || rule.explanation || `${rule.kind}: ${rule.value}`));
        option.append(action("Keep this rule", async () => mutate("/api/memory/resolve", { keep_id: id, remove_ids: ids.filter((other) => other !== id) }, "Conflict resolved. The selected rule is now active.")));
        block.append(option);
      }
      container.append(block);
    }
  }

  function routineRow(item) {
    const row = make("article", "memory-record");
    row.append(make("h3", "", item.name));
    const aliases = Array.isArray(item.aliases) ? item.aliases : [];
    row.append(make("p", "record-kind", `Triggers: ${[item.name, ...aliases].join(" · ")}`));
    const prompt = String(item.prompt || "");
    row.append(make("p", "record-content", prompt.length > 480 ? `${prompt.slice(0, 480)}…` : prompt));
    if (prompt.length > 480) row.append(detail("Read the complete saved request", prompt, `${item.id}-prompt`));
    row.append(detail("Saved routine · raw testing record", item, `${item.id}-routine`));
    const actions = make("div", "record-actions");
    actions.append(action("Edit", () => {
      $("routine-id").value = item.id;
      $("routine-name").value = item.name;
      $("routine-aliases").value = aliases.join("\n");
      $("routine-prompt").value = item.prompt;
      $("routine-editor").open = true;
      $("routine-name").focus();
    }), action("Delete", () => mutate("/api/routines/delete", { id: item.id }, "Routine deleted. Its trigger phrases no longer start that request.")));
    row.append(actions);
    return row;
  }

  function renderPendingRoutine(pending, routines) {
    const container = $("routine-pending");
    container.hidden = !pending;
    const signature = JSON.stringify(pending);
    if (listSignatures.get("pending-routine") === signature) return;
    listSignatures.set("pending-routine", signature);
    container.replaceChildren();
    if (!pending) return;
    container.append(make("h3", "", "Routine awaiting confirmation"));
    const routine = routines.find((item) => item.id === pending.routine_id);
    container.append(make("p", "help", `No routine has started from this match. Reply “yes” in this conversation${routine ? ` to run ${routine.name}` : " to continue"}, or “no” to decline.`));
    if (pending.expires_at) container.append(make("p", "help", `Confirmation expires ${when(pending.expires_at)}.`));
    container.append(detail("Pending match · raw testing record", pending, "pending-routine"));
  }

  function renderEvents(events) {
    const display = events.slice(-30).reverse();
    renderList("memory-events", display, (item) => {
      const row = make("li", "activity-event");
      row.append(make("p", "record-kind", `${when(item.created_at)} · ${item.type || "Memory operation"}`));
      row.append(make("p", "", item.message || ""));
      if (item.details) row.append(detail("Operation details", item.details, `${item.id || item.created_at}-${item.type}`));
      return row;
    }, "Learning and memory operations will appear here after you chat or change memory.");
  }

  function render(data) {
    snapshot = data;
    const facts = data.facts || [];
    const rules = data.rules || [];
    const documents = data.documents || [];
    const routines = data.routines || [];
    const conversations = (data.conversations || []).filter((item) => !item.session_id || item.session_id === getSessionId());
    const learning = data.learning || {};
    const learningMessage = learning.running ? "Learning from the conversation…" : learning.pending ? `${learning.pending} learning ${learning.pending === 1 ? "job" : "jobs"} queued` : "Memory is up to date";
    $("memory-status").textContent = `${learning.error ? "Learning needs attention" : learningMessage} · revision ${data.revision ?? "—"}`;
    if (learning.error) feedback(`Background learning failed: ${typeof learning.error === "string" ? learning.error : JSON.stringify(learning.error)}`, true);
    $("retry-learning").hidden = !learning.error;
    $("count-conversation").textContent = conversations.length;
    $("count-facts").textContent = facts.filter((item) => item.status !== "superseded").length;
    $("count-rules").textContent = rules.length;
    $("count-documents").textContent = documents.length;
    $("count-routines").textContent = routines.length;
    renderList("memory-conversation-list", conversations, conversationRow, "No saved messages in this conversation yet. Send a message to see its exact source record.");
    renderList("memory-facts-list", facts, factRow, "No household memories yet. Tell MERLIN a useful fact or preference, or add one below.");
    renderList("memory-rules-list", rules, ruleRow, "No explicit rules saved. Try “Always use seconds for timers unless I specify another unit.”");
    renderList("memory-documents-list", documents, documentRow, "No documents yet. Save a named routine, plan, or reference below.");
    renderList("memory-routines-list", routines, routineRow, "No routines yet. Save a phrase and the request it should run below. Nothing is installed by default.");
    renderPendingRoutine(data.pending_routine, routines);
    renderConflicts(data.conflicts || [], rules);
    renderEvents(data.events || []);
    if (data.retention) $("memory-retention").textContent = data.retention;
    if (restoring && !isChatBusy()) {
      restoreConversation(conversations);
      restoring = false;
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    if (isChatBusy() || (!snapshot?.learning?.error && (snapshot?.learning?.pending || snapshot?.learning?.running))) refreshTimer = setTimeout(refresh, 2500);
  }

  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    $("refresh-memory").disabled = true;
    const session = getSessionId();
    try {
      const data = await request(`/api/memory?session_id=${encodeURIComponent(session)}`, undefined, 10000);
      if (session === getSessionId()) {
        $("memory-error").hidden = true;
        render(data);
      }
    } catch (error) {
      $("memory-status").textContent = "Memory could not be loaded";
      feedback(`${error.message} Use Refresh to try again.`, true);
    } finally {
      refreshing = false;
      $("refresh-memory").disabled = false;
      if (refreshAgain) { refreshAgain = false; clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 0); }
      else scheduleRefresh();
    }
  }

  async function submit(form, path, body, message, reset) {
    const controls = [...form.querySelectorAll("button, input, textarea, select")].map((control) => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; });
    form.setAttribute("aria-busy", "true");
    try { await mutate(path, body, message); reset?.(); }
    catch (error) { feedback(error.message, true); }
    finally {
      controls.forEach(({ control, disabled }) => { control.disabled = disabled; });
      form.setAttribute("aria-busy", "false");
    }
  }

  function resetFact() { $("memory-fact-form").reset(); $("fact-id").value = ""; }
  function resetDocument() { $("memory-document-form").reset(); $("document-id").value = ""; }
  function resetRoutine() { $("memory-routine-form").reset(); $("routine-id").value = ""; }
  $("cancel-fact-edit").addEventListener("click", resetFact);
  $("cancel-document-edit").addEventListener("click", resetDocument);
  $("cancel-routine-edit").addEventListener("click", resetRoutine);
  $("refresh-memory").addEventListener("click", refresh);
  $("retry-learning").addEventListener("click", async () => {
    const button = $("retry-learning");
    button.disabled = true;
    try { await mutate("/api/memory/retry-learning", {}, "Background learning queued for another attempt."); }
    catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });
  $("memory-fact-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submit(event.currentTarget, "/api/memory/fact", { id: $("fact-id").value || undefined, content: $("fact-content").value.trim(), subject: $("fact-subject").value.trim(), kind: $("fact-kind").value }, "Household memory saved.", resetFact);
  });

  function updateRuleFields() {
    const kind = $("rule-kind").value;
    const help = {
      timer_default_unit: "Use seconds, minutes, or hours. An explicit unit in a request takes priority.",
      timer_default_seconds: "Use a whole number from 1 to 604,800 seconds when a timer request leaves out its length. For example, 300 means five minutes. A stated length takes priority.",
      address_as: "The exact name or title to use, for example Sir.",
      avoid_word: "One exact word. This is a wording restriction, not a ban on a topic.",
      avoid_phrase: "The exact phrase to exclude. This does not block paraphrases or related ideas.",
      response_prefix: "Exact text required at the beginning of a response.",
      response_suffix: "Exact text required at the end of a response.",
      tool_deny: "Use create_timer, cancel_timer, or web_search.",
      timer_max_seconds: "A positive whole number of seconds. Longer timer actions will be blocked.",
    };
    $("rule-value-help").textContent = help[kind];
    $("rule-scope").value = kind.startsWith("timer_") ? "timers" : kind === "tool_deny" ? "tools" : "assistant_reply";
    const numeric = ["timer_max_seconds", "timer_default_seconds"].includes(kind);
    $("rule-value").type = numeric ? "number" : "text";
    $("rule-value").min = "1";
    $("rule-value").max = "604800";
    $("rule-value").step = "1";
  }
  $("rule-kind").addEventListener("change", updateRuleFields);
  updateRuleFields();
  $("memory-rule-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const kind = $("rule-kind").value;
    submit(event.currentTarget, "/api/memory/rule", { kind, value: ["timer_max_seconds", "timer_default_seconds"].includes(kind) ? Number($("rule-value").value) : $("rule-value").value.trim(), scope: $("rule-scope").value, original: $("rule-original").value.trim() || undefined }, "Rule saved. Any conflicting rules are flagged above.", () => { $("memory-rule-form").reset(); updateRuleFields(); });
  });
  $("memory-document-form").addEventListener("submit", (event) => {
    event.preventDefault();
    submit(event.currentTarget, "/api/documents", { id: $("document-id").value || undefined, title: $("document-title").value.trim(), description: $("document-description").value.trim(), content: $("document-content").value }, "Document saved. Its catalog is available for relevant requests.", resetDocument);
  });
  $("memory-routine-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const aliases = [...new Set($("routine-aliases").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
    if (aliases.length > 12 || aliases.some((value) => value.length > 120)) {
      feedback("Use at most 12 trigger phrases, with no more than 120 characters per phrase.", true);
      $("routine-aliases").focus();
      return;
    }
    submit(event.currentTarget, "/api/routines", { id: $("routine-id").value || undefined, name: $("routine-name").value.trim(), aliases, prompt: $("routine-prompt").value.trim() }, "Routine saved. Use its name or a trigger phrase as a command when you want to run it.", resetRoutine);
  });
  $("document-file").addEventListener("change", async () => {
    const file = $("document-file").files[0];
    if (!file) return;
    try {
      if (!/\.(txt|md)$/i.test(file.name)) throw new Error("Choose a .txt or .md file.");
      if (file.size > 400000) throw new Error("This file is too large. Use a document with at most 100,000 characters.");
      const content = await file.text();
      if (content.length > 100000) throw new Error("This document exceeds 100,000 characters. Split it into smaller named documents.");
      $("document-content").value = content;
      if (!$("document-title").value) $("document-title").value = file.name.replace(/\.(txt|md)$/i, "").slice(0, 160);
      feedback("File read into the editor. Review it, then choose Save document.");
    } catch (error) { feedback(error.message, true); $("document-file").value = ""; }
  });
  $("clear-memory").addEventListener("click", async () => {
    if (!window.confirm("Delete all saved conversations, household memories, rules, documents, routines, and memory activity? This cannot be undone. Timers are kept.")) return;
    const button = $("clear-memory");
    button.disabled = true;
    try {
      await mutate("/api/memory/clear", {}, "All saved memory deleted. Timers are unchanged.");
      restoreConversation([]);
      resetFact(); resetDocument(); resetRoutine();
    } catch (error) { feedback(error.message, true); }
    finally { button.disabled = false; }
  });
  $("delete-conversation").addEventListener("click", async () => {
    if (!window.confirm("Delete the messages in this conversation? Saved household memories and rules are kept.")) return;
    try { await deleteConversation(); feedback("Conversation messages deleted. Saved household memories and rules are kept."); await refresh(); }
    catch (error) { feedback(error.message, true); }
  });

  function renderTrace(entry, trace, pending = false) {
    let panel = entry.querySelector(".request-trace");
    if (!panel) {
      panel = make("details", "request-trace");
      panel.append(make("summary", "", "Behind this response"), make("div", "trace-content"));
      entry.append(panel);
    }
    const events = trace?.events || [];
    const summaryParts = [];
    if (Number.isFinite(trace?.total_ms)) summaryParts.push(`${(trace.total_ms / 1000).toFixed(2)} s`);
    if (Number.isFinite(trace?.model_calls)) summaryParts.push(`${trace.model_calls} model ${trace.model_calls === 1 ? "call" : "calls"}`);
    panel.querySelector("summary").textContent = `Behind this response${pending ? " · live" : ""}`;
    const content = panel.querySelector(".trace-content");
    const open = new Set([...content.querySelectorAll("details[open][data-detail]")].map((node) => node.dataset.detail));
    content.replaceChildren(make("p", "help", "Execution stages and raw testing records. These show selected memory, checks, actions, and timings—not private model reasoning."));
    if (summaryParts.length) content.append(make("p", "trace-measure", summaryParts.join(" · ")));
    if (Number.isFinite(trace?.context_chars)) content.append(make("p", "trace-measure", `${trace.context_chars.toLocaleString()} context characters selected (characters are not tokens).`));
    if (!events.length) content.append(make("p", "help", pending ? "Waiting for the first recorded stage…" : "No execution stages were returned."));
    const timeline = make("ol", "trace-timeline");
    events.forEach((event, index) => {
      const row = make("li", "trace-event");
      const elapsed = Number.isFinite(event.at_ms) ? `${Math.round(event.at_ms)} ms` : "";
      row.append(make("p", "trace-stage", `${event.stage || "Stage"}${elapsed ? " · " + elapsed : ""}`));
      if (event.detail) row.append(make("p", "", typeof event.detail === "string" ? event.detail : JSON.stringify(event.detail)));
      if (event.data) row.append(detail("Recorded inputs and results", event.data, `event-${index}`));
      timeline.append(row);
    });
    content.append(timeline);
    if (Array.isArray(trace?.tool_events) && trace.tool_events.length) {
      content.append(make("p", "sources-label", "Recorded tool outcomes"));
      const outcomes = make("ul", "tool-results diagnostic-tool-results");
      outcomes.setAttribute("aria-label", "Recorded tool outcomes");
      for (const event of trace.tool_events) {
        const row = make("li", "");
        row.append(make("strong", "", `${event.tool || "Tool"} · ${event.status || "Result"}`));
        if (event.message) row.append(document.createTextNode(` — ${event.message}`));
        outcomes.append(row);
      }
      content.append(outcomes);
    }
    if (trace?.usage) content.append(detail("Reported model usage", trace.usage, "usage"));
    for (const item of content.querySelectorAll("details[data-detail]")) item.open = open.has(item.dataset.detail);
  }

  async function pollTrace() {
    const active = activeTrace;
    if (!active) return;
    try {
      const trace = await request(`/api/trace?request_id=${encodeURIComponent(active.requestId)}`, undefined, 6000);
      if (activeTrace !== active) return;
      renderTrace(active.entry, trace, trace.status === "running" || trace.status === "pending");
    } catch { /* Chat delivery remains independent of the optional inspection endpoint. */ }
    if (activeTrace === active) traceTimer = setTimeout(pollTrace, 1000);
  }

  if (window.matchMedia("(max-width: 760px)").matches) $("memory-lab").open = false;
  refresh();
  return {
    refresh,
    begin(requestId, entry) {
      restoring = false;
      clearTimeout(traceTimer);
      activeTrace = { requestId, entry };
      renderTrace(entry, {}, true);
      pollTrace();
      scheduleRefresh();
    },
    finish(entry, data) {
      const requestId = activeTrace?.requestId;
      activeTrace = null;
      clearTimeout(traceTimer);
      const tool_events = Array.isArray(data?.tool_events) ? data.tool_events : [];
      if (data?.trace) renderTrace(entry, { ...data.trace, tool_events });
      else {
        // Preserve diagnostic outcomes even if the optional trace endpoint fails.
        renderTrace(entry, { tool_events });
        if (requestId) request(`/api/trace?request_id=${encodeURIComponent(requestId)}`, undefined, 6000).then((trace) => renderTrace(entry, { ...trace, tool_events })).catch(() => {});
      }
      refresh();
    },
    newConversation() { restoring = true; refresh(); },
    renderTrace,
  };
};
