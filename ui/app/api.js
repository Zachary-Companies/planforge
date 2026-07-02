// Thin API client for the PlanForge UI server. No dependencies.

async function parseError(res) {
  let msg = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body && body.error) msg = body.error;
  } catch { /* non-JSON error body */ }
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

export async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw await parseError(res);
  return res.json();
}

/** Like apiGet but a 404 resolves to null (e.g. preferences not written yet). */
export async function apiGetOrNull(path) {
  const res = await fetch(path);
  if (res.status === 404) return null;
  if (!res.ok) throw await parseError(res);
  return res.json();
}

export async function apiText(path) {
  const res = await fetch(path);
  if (!res.ok) throw await parseError(res);
  return res.text();
}

export async function apiPost(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw await parseError(res);
  return res.json();
}

/**
 * POST and consume a chunked NDJSON progress stream (plan generate/revise).
 * Calls onEvent for every parsed line; resolves with the last event
 * ({type:"done"|"error", …}). Throws on transport/HTTP errors.
 */
export async function streamNdjson(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!res.ok) throw await parseError(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let last = null;
  const feed = (line) => {
    if (!line.trim()) return;
    let obj;
    try { obj = JSON.parse(line); } catch { return; }
    last = obj;
    try { onEvent(obj); } catch { /* view errors must not kill the stream */ }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) feed(line);
  }
  feed(buf);
  return last;
}

/**
 * Subscribe to a run's live event stream (SSE). The server replays
 * events.ndjson from byte 0 and then tails it — the caller is fully
 * event-sourced. Returns { close }.
 */
export function openRunEvents(runId, onEvent, onStateChange) {
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  es.onopen = () => onStateChange?.(true);
  es.onerror = () => onStateChange?.(false);
  es.onmessage = (msg) => {
    let obj;
    try { obj = JSON.parse(msg.data); } catch { return; }
    try { onEvent(obj); } catch { /* keep the stream alive */ }
  };
  return { close: () => { try { es.close(); } catch { /* already closed */ } } };
}
