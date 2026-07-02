// Shared DOM + formatting helpers. No dependencies.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 12345 → "12s", 754321 → "12m34s", … */
export function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${pad2(s % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h${pad2(m % 60)}m`;
}

export function fmtClock(t) {
  const d = new Date(t);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** epoch ms → "3m ago" / "yesterday" / "Jun 12" */
export function relTime(t) {
  if (!t) return '—';
  const diff = Date.now() - t;
  if (diff < 45_000) return 'just now';
  if (diff < 90_000) return 'a minute ago';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 172_800_000) return 'yesterday';
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "2026-07-02T09-15-30-123Z" (run id) → friendly local date-time */
export function runIdToLabel(id) {
  const m = String(id).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return id;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const shortRepo = (r) => { const s = String(r ?? ''); const i = s.indexOf('/'); return i < 0 ? s : s.slice(i + 1); };

/** Build one element from an HTML string. */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(msg, kind = 'ok', ms = 3600) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const node = h(`<div class="toast ${esc(kind)}" role="status">${esc(msg)}</div>`);
  host.appendChild(node);
  requestAnimationFrame(() => node.classList.add('in'));
  setTimeout(() => {
    node.classList.remove('in');
    setTimeout(() => node.remove(), 300);
  }, ms);
}

export const spinner = (label = '') => `<span class="spinner" aria-hidden="true"></span>${label ? `<span class="dim">${esc(label)}</span>` : ''}`;
