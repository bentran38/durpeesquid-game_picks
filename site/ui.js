// Small DOM helpers and formatting shared by every page.

export const $ = (id) => document.getElementById(id);

export const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return n;
};

export const POSTSEASON = { 1: 'Wild Card', 2: 'Divisional', 3: 'Conference', 5: 'Super Bowl' };
export const weekLabel = (stype, week) => (stype === 3 ? POSTSEASON[week] ?? `Playoffs ${week}` : `Week ${week}`);
export const periodKey = (p) => `${p.stype}-${p.week}`;

export const pct = (n) => (n == null ? '–' : `${Number(n).toFixed(1)}%`);
export const num = (n, d = 1) => (n == null ? '–' : Number(n).toFixed(d));
export const fmtTime = (iso) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function logo(url, className = 'logo') {
  if (typeof url !== 'string' || !url.startsWith('https://')) return el('span', { className });
  return el('img', { className, alt: '', loading: 'lazy', src: url });
}

let toastTimer;
export function toast(text, isError = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2400);
}

/** A labelled <select>. options: [value, text][] */
export function select(label, options, value, onchange) {
  const s = el('select');
  for (const [v, text] of options) s.append(new Option(text, String(v), false, String(v) === String(value)));
  s.value = String(value);
  s.onchange = () => onchange(s.value);
  return el('label', { className: 'field' }, label, s);
}

export const stat = (label, value, small = false) =>
  el('div', { className: 'tile-stat' }, el('span', { className: 'stat-label' }, label), el('span', { className: `stat-value${small ? ' small' : ''}` }, value));

/**
 * Sortable table. cols: { label, val(row) -> value to sort by, cell?(row) -> node or text, num? }
 * Clicking a header re-sorts; `sortCol`/`desc` give the first order.
 */
export function table(cols, rows, { onRow, sortCol = null, desc = true } = {}) {
  if (!rows.length) return el('p', { className: 'empty' }, 'Nothing to show yet.');
  let sc = sortCol, sd = desc;
  const wrap = el('div', { className: 'table-wrap' });
  const draw = () => {
    const data = [...rows];
    if (sc != null) {
      const c = cols[sc];
      data.sort((a, b) => {
        const x = c.val(a), y = c.val(b);
        const r = typeof x === 'string' || typeof y === 'string' ? String(x ?? '').localeCompare(String(y ?? '')) : (x ?? -Infinity) - (y ?? -Infinity);
        return sd ? -r : r;
      });
    }
    wrap.replaceChildren(
      el('table', {},
        el('thead', {}, el('tr', {}, cols.map((c, i) =>
          el('th', {
            className: `sortable${c.num ? ' num' : ''}`, title: c.title ?? '',
            onclick: () => { if (sc === i) sd = !sd; else { sc = i; sd = c.num !== false; } draw(); },
          }, c.label, sc === i ? (sd ? ' ▼' : ' ▲') : ''))),
        ),
        el('tbody', {}, data.map((row) =>
          el('tr', { className: onRow ? 'click' : '', onclick: onRow ? () => onRow(row) : null },
            cols.map((c) => el('td', { className: c.num ? 'num' : '' }, c.cell ? c.cell(row) : c.val(row) ?? '–')))))),
    );
  };
  draw();
  return wrap;
}

// ---- totals ---------------------------------------------------------------------------------

const ADD = ['games', 'correct', 'exact', 'points', 'margin_err_sum', 'total_err_sum'];

/** Adds up rows from week_scores / season_scores / team_stats and works out the ratios. */
export function totals(rows) {
  const t = Object.fromEntries(ADD.map((k) => [k, 0]));
  for (const r of rows) for (const k of ADD) t[k] += Number(r[k] ?? 0);
  return finish(t);
}

export function finish(t) {
  const n = t.games;
  return {
    ...t,
    pct: n ? (100 * t.correct) / n : null,
    avgPoints: n ? t.points / n : null,
    avgMarginErr: n ? t.margin_err_sum / n : null,
    avgTotalErr: n ? t.total_err_sum / n : null,
  };
}
