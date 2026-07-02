// Normalizes /api/questions into what the views render, tolerating both the
// canonical planning/questions.json shape (flat arrays with `group`/`mapsTo`)
// and a grouped/stepped variant, so the UI degrades gracefully if the file
// evolves.
//
// Canonical shape:
//   preferences: [{ id, group, label, help, type, options, mapsTo }]
//     type: select | multiselect. Option "No preference" ⇒ omit the field;
//     option "Other" ⇒ free-text input. mapsTo: dotted path ("webApp.db").
//   interview:   [{ id, label, help, type, placeholder, options?, required? }]

const GROUP_TITLES = {
  general: 'General',
  webApp: 'Web apps',
  mobileApp: 'Mobile apps',
  api: 'APIs & services',
  cli: 'CLI tools',
  data: 'Data & analytics',
};

const GROUP_DESCRIPTIONS = {
  general: 'Cross-cutting defaults that apply to every project.',
  webApp: 'Your go-to stack when the plan calls for a web frontend.',
  mobileApp: 'For plans that include an iOS/Android app.',
  api: 'For backend services and public APIs.',
  cli: 'For command-line tools.',
  data: 'For pipelines, analytics, and ML projects.',
};

const NO_PREF = /^no preference$/i;
const OTHER = /^other$/i;

function normType(type) {
  const t = String(type ?? '').toLowerCase();
  if (t === 'multiselect' || t === 'multi-select') return 'multiselect';
  if (t === 'select') return 'select';
  if (t === 'textarea') return 'textarea';
  return 'text';
}

const optionValue = (o) => (typeof o === 'object' && o !== null ? String(o.value ?? o.id ?? '') : String(o));
const optionLabel = (o) => (typeof o === 'object' && o !== null ? String(o.label ?? o.value ?? o.id ?? '') : String(o));

function normQuestion(q, group) {
  const raw = Array.isArray(q.options) ? q.options : [];
  const options = raw
    .filter((o) => !NO_PREF.test(optionValue(o)) && !OTHER.test(optionValue(o)))
    .map((o) => ({ value: optionValue(o), label: optionLabel(o) }));
  return {
    id: String(q.id ?? ''),
    label: q.label ?? q.id ?? '',
    help: q.help ?? q.hint ?? '',
    placeholder: q.placeholder ?? '',
    type: normType(q.type),
    required: Boolean(q.required),
    options,
    // free-text escape hatch: an explicit "Other" option, `custom: true`,
    // or an option-less select
    allowOther: raw.some((o) => OTHER.test(optionValue(o))) || Boolean(q.custom),
    mapsTo: typeof q.mapsTo === 'string' && q.mapsTo.includes('.')
      ? q.mapsTo
      : group ? `${group}.${q.id}` : null,
  };
}

/** → [{ id, title, description, questions: [normalized…] }] */
export function preferenceGroups(questions) {
  const prefs = questions?.preferences;
  let flat = [];
  if (Array.isArray(prefs)) {
    flat = prefs.map((q) => ({ q, group: q.group ?? 'general' }));
  } else if (Array.isArray(prefs?.groups)) {
    for (const g of prefs.groups) {
      for (const q of (g.questions ?? [])) flat.push({ q, group: g.id ?? 'general' });
    }
  }
  const byGroup = new Map();
  for (const { q, group } of flat) {
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(normQuestion(q, group));
  }
  return [...byGroup.entries()].map(([id, qs]) => ({
    id,
    title: GROUP_TITLES[id] ?? id,
    description: GROUP_DESCRIPTIONS[id] ?? '',
    questions: qs,
  }));
}

/** → [{ id, title, questions: [normalized…] }] — one wizard step per entry. */
export function interviewSteps(questions) {
  const iv = questions?.interview;
  if (Array.isArray(iv)) {
    return iv.map((q) => ({ id: String(q.id ?? ''), title: q.label ?? q.id ?? '', questions: [normQuestion(q, null)] }));
  }
  if (Array.isArray(iv?.steps)) {
    return iv.steps.map((s) => ({
      id: String(s.id ?? ''),
      title: s.title ?? s.id ?? '',
      questions: (s.questions ?? []).map((q) => normQuestion(q, null)),
    }));
  }
  return [];
}

/** Dotted-path helpers for stack-preferences.json values. */
export function getPath(obj, path) {
  if (!path) return undefined;
  let cur = obj;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

export function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] === null || typeof cur[keys[i]] !== 'object' || Array.isArray(cur[keys[i]])) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

export function deletePath(obj, path) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur === null || typeof cur !== 'object') return;
    cur = cur[keys[i]];
  }
  if (cur && typeof cur === 'object') delete cur[keys[keys.length - 1]];
}
