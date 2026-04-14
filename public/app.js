/* =========================================================
   RBO IT Ticket Dashboard — Frontend Logic
   ========================================================= */

'use strict';

// ─── State ────────────────────────────────────────────────
const state = {
  tasks:       [],
  filtered:    [],
  sortCol:     'created',
  sortDir:     'desc',
  page:        0,
  pageSize:    25,
  autoRefresh: true,
  refreshTimer: null,
  charts:      {},
  cardFilter:  null,   // quick-filter set by metric card clicks
  activeCard:  null,   // id of the currently active metric card
  dateFrom:    null,
  dateTo:      null,
};

// Metric card → filter function mapping
const CARD_FILTERS = {
  'mc-total':      null,
  'mc-open':       t => t.status === 'to do',
  'mc-inprogress': t => ['in progress', 'next in line', 'backlog'].includes(t.status),
  'mc-review':     t => t.status === 'awaiting review',
  'mc-complete':   t => t.statusType === 'closed',
  'mc-unassigned': t => !t.assignees?.length,
};

// ─── Colour helpers ────────────────────────────────────────
const STATUS_BG = {
  'to do':          { bg: 'rgba(211,61,68,0.18)',   text: '#f87171', dot: '#f87171'  },
  'backlog':        { bg: 'rgba(68,102,255,0.18)',  text: '#7b9ef8', dot: '#7b9ef8'  },
  'next in line':   { bg: 'rgba(225,107,22,0.18)',  text: '#f0883e', dot: '#f0883e'  },
  'in progress':    { bg: 'rgba(16,144,224,0.18)',  text: '#58b4f8', dot: '#58b4f8'  },
  'awaiting review':{ bg: 'rgba(0,136,68,0.2)',     text: '#3fb950', dot: '#3fb950'  },
  'complete':       { bg: 'rgba(0,136,68,0.15)',    text: '#3fb950', dot: '#3fb950'  },
};

const PRIORITY_META = {
  'urgent': { color: '#f85149', icon: '⬆⬆', label: 'Urgent' },
  'high':   { color: '#f0883e', icon: '⬆',   label: 'High'   },
  'normal': { color: '#58a6ff', icon: '➡',   label: 'Normal' },
  'low':    { color: '#6e7681', icon: '⬇',   label: 'Low'    },
  'none':   { color: '#6e7681', icon: '—',   label: 'None'   },
};

// ─── DOM helpers ─────────────────────────────────────────
const $  = id  => document.getElementById(id);
const $$ = sel => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class')   e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  });
  children.forEach(c => {
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else if (c) e.appendChild(c);
  });
  return e;
}

// ─── Date helpers ─────────────────────────────────────────
function relativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000)       return 'just now';
  if (diff < 3_600_000)    return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000)   return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  const d = new Date(ts);
  const now = new Date();
  const opts = { month: 'short', day: 'numeric' };
  if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-US', opts);
}

function fullDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}

function dueClass(ts, statusType) {
  if (!ts || statusType === 'closed') return 'date-none';
  const diff = ts - Date.now();
  if (diff < 0)               return 'date-overdue';
  if (diff < 2 * 86_400_000)  return 'date-soon';
  return '';
}

// ─── Render helpers ───────────────────────────────────────
function statusBadge(status, color) {
  const meta = STATUS_BG[status?.toLowerCase()] || { bg: 'rgba(139,148,158,0.2)', text: color || '#8b949e', dot: color || '#8b949e' };
  return `<span class="badge" style="background:${meta.bg};color:${meta.text}">
    <span class="badge-dot" style="background:${meta.dot}"></span>${status || 'unknown'}
  </span>`;
}

function priorityBadge(priority) {
  const meta = PRIORITY_META[priority?.toLowerCase()] || PRIORITY_META['none'];
  return `<span class="priority-badge" style="color:${meta.color}">
    <span class="priority-icon">${meta.icon}</span>${meta.label}
  </span>`;
}

function assigneeAvatars(assignees) {
  if (!assignees?.length) return `<span class="assignees-none">Unassigned</span>`;
  const avatarsHtml = assignees.slice(0, 4).map(a =>
    `<span class="avatar" title="${a.name}" style="background:${a.color || '#58a6ff'}">${a.initials}</span>`
  ).join('');
  const extra = assignees.length > 4 ? `<span class="avatar" style="background:#30363d;color:#8b949e">+${assignees.length - 4}</span>` : '';
  return `<div class="assignees">${avatarsHtml}${extra}</div>`;
}

// ─── Fetch data ────────────────────────────────────────────
async function fetchTickets(force = false) {
  setLoading(true);
  setError(null);
  try {
    const url = force ? '/api/tickets?force=true' : '/api/tickets';
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`Server error: ${res.status}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || 'Unknown error');
    state.tasks = data.tasks || [];
    state.page  = 0;
    updateLastUpdated(data.fetchedAt || Date.now());
    applyFilters();
    renderMetrics();
    renderCharts();
    populateFilters();
  } catch (err) {
    setError(err.message);
  } finally {
    setLoading(false);
  }
}

// ─── Loading / error ──────────────────────────────────────
function setLoading(on) {
  $('loadingOverlay').classList.toggle('hidden', !on);
  const btn = $('btnRefresh');
  btn.classList.toggle('spinning', on);
  btn.disabled = on;
}

function setError(msg) {
  const banner = $('errorBanner');
  if (msg) {
    $('errorText').textContent = msg;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function updateLastUpdated(ts) {
  $('lastUpdated').textContent = `Updated ${relativeTime(ts)}`;
}

// ─── Filters ──────────────────────────────────────────────
function applyFilters() {
  const q       = $('searchInput').value.toLowerCase().trim();
  const status  = $('statusFilter').value;
  const prio    = $('priorityFilter').value;
  const assinee = $('assigneeFilter').value;
  const msFrom  = state.dateFrom ? new Date(state.dateFrom + 'T00:00:00').getTime() : null;
  const msTo    = state.dateTo   ? new Date(state.dateTo   + 'T23:59:59').getTime() : null;

  state.filtered = state.tasks.filter(t => {
    // Quick-filter from metric card click
    if (state.cardFilter && !state.cardFilter(t)) return false;
    if (status && t.status !== status) return false;
    if (prio   && t.priority !== prio)  return false;
    if (assinee === '__unassigned__' && t.assignees.length) return false;
    if (assinee && assinee !== '__unassigned__') {
      if (!t.assignees.some(a => a.name === assinee)) return false;
    }
    if (msFrom && (!t.created || t.created < msFrom)) return false;
    if (msTo   && (!t.created || t.created > msTo))   return false;
    if (q) {
      const haystack = [t.name, t.requester, t.status, t.priority,
        ...t.assignees.map(a => a.name), ...t.tags].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  // Update date filter badge
  const badge    = $('dateResultBadge');
  const clearBtn = $('btnClearDates');
  const card     = $('dateFilterCard');
  if (msFrom || msTo) {
    const n = state.filtered.length;
    badge.textContent = `${n} ticket${n !== 1 ? 's' : ''} found`;
    badge.hidden  = false;
    clearBtn.hidden = false;
    card.classList.add('date-active');
  } else {
    badge.hidden  = true;
    clearBtn.hidden = true;
    card.classList.remove('date-active');
  }

  state.page = 0;
  sortTasks();
  renderTable();
  renderCharts();
}

function setActiveCard(cardId) {
  // Toggle: clicking the same card again clears the filter
  if (state.activeCard === cardId || cardId === 'mc-total') {
    state.cardFilter = null;
    state.activeCard = null;
  } else {
    state.cardFilter = CARD_FILTERS[cardId] || null;
    state.activeCard = cardId;
  }

  // Update highlight on all cards
  Object.keys(CARD_FILTERS).forEach(id => {
    $$(`.metric-card#${id}`)?.classList.toggle('card-active', id === state.activeCard);
  });

  // Clear the sidebar filters when using a card filter
  $('searchInput').value = '';
  $('statusFilter').value = '';
  $('priorityFilter').value = '';
  $('assigneeFilter').value = '';

  state.page = 0;
  applyFilters();

  // Scroll to the tickets table
  document.querySelector('.tickets-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function populateFilters() {
  // Status options
  const statusSel = $('statusFilter');
  const currentStatus = statusSel.value;
  const statuses = [...new Set(state.tasks.map(t => t.status))].sort();
  statusSel.innerHTML = '<option value="">All Statuses</option>';
  statuses.forEach(s => {
    const o = document.createElement('option');
    o.value = s; o.textContent = s;
    if (s === currentStatus) o.selected = true;
    statusSel.appendChild(o);
  });

  // Assignee options
  const assSel = $('assigneeFilter');
  const currentAss = assSel.value;
  const names = [...new Set(state.tasks.flatMap(t => t.assignees.map(a => a.name)))].sort();
  assSel.innerHTML = '<option value="">All Assignees</option><option value="__unassigned__">Unassigned</option>';
  names.forEach(n => {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    if (n === currentAss) o.selected = true;
    assSel.appendChild(o);
  });
}

// ─── Sorting ──────────────────────────────────────────────
function sortTasks() {
  const { sortCol, sortDir } = state;
  const dir = sortDir === 'asc' ? 1 : -1;

  state.filtered.sort((a, b) => {
    let va, vb;
    if (sortCol === 'created')  { va = a.created  || 0; vb = b.created  || 0; }
    else if (sortCol === 'due') { va = a.due       || 0; vb = b.due       || 0; }
    else if (sortCol === 'status')   { va = a.status;   vb = b.status;   }
    else if (sortCol === 'priority') { va = a.priorityOrder || 99; vb = b.priorityOrder || 99; }
    else { va = 0; vb = 0; }

    if (typeof va === 'string') return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
}

// ─── Render metrics ───────────────────────────────────────
function renderMetrics() {
  const t = state.tasks;
  $('stat-total').textContent      = t.length;
  $('stat-open').textContent       = t.filter(x => x.status === 'to do').length;
  $('stat-inprogress').textContent = t.filter(x => ['in progress','next in line','backlog'].includes(x.status)).length;
  $('stat-review').textContent     = t.filter(x => x.status === 'awaiting review').length;
  $('stat-complete').textContent   = t.filter(x => x.statusType === 'closed').length;
  $('stat-unassigned').textContent = t.filter(x => !x.assignees?.length).length;
}

// ─── Render charts ────────────────────────────────────────
function renderCharts() {
  renderStatusChart();
  renderPriorityChart();
  renderTimelineChart();
}

function destroyChart(key) {
  if (state.charts[key]) { state.charts[key].destroy(); delete state.charts[key]; }
}

function renderStatusChart() {
  destroyChart('status');
  const counts = {};
  state.filtered.forEach(t => { counts[t.status] = (counts[t.status] || 0) + 1; });
  const labels = Object.keys(counts);
  const data   = labels.map(k => counts[k]);
  const colors = labels.map(k => {
    const m = STATUS_BG[k?.toLowerCase()];
    return m ? m.dot : '#8b949e';
  });

  state.charts.status = new Chart($('statusChart'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 2, borderColor: '#161b22', hoverOffset: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12, padding: 10 } },
        tooltip: { callbacks: {
          label: ctx => ` ${ctx.label}: ${ctx.parsed} ticket${ctx.parsed !== 1 ? 's' : ''}`
        }}
      }
    }
  });
}

function renderPriorityChart() {
  destroyChart('priority');
  const order  = ['urgent', 'high', 'normal', 'low', 'none'];
  const counts = {};
  order.forEach(p => { counts[p] = 0; });
  state.filtered.forEach(t => {
    const p = t.priority?.toLowerCase() || 'none';
    if (p in counts) counts[p]++;
  });
  const labels = order.filter(p => counts[p] > 0).map(p => PRIORITY_META[p].label);
  const data   = order.filter(p => counts[p] > 0).map(p => counts[p]);
  const colors = order.filter(p => counts[p] > 0).map(p => PRIORITY_META[p].color);

  state.charts.priority = new Chart($('priorityChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: 'Tickets', data, backgroundColor: colors.map(c => c + '55'), borderColor: colors, borderWidth: 2, borderRadius: 6 }] },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: 'y',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.x} ticket${ctx.parsed.x !== 1 ? 's' : ''}` } }
      },
      scales: {
        x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 11 } } },
        y: { grid: { display: false }, ticks: { color: '#8b949e', font: { size: 11 } } }
      }
    }
  });
}

function renderTimelineChart() {
  destroyChart('timeline');
  const DAY = 86_400_000;
  const now  = Date.now();

  // Adapt window to active date filter, else default to last 30 days
  const msFrom = state.dateFrom ? new Date(state.dateFrom + 'T00:00:00').getTime() : null;
  const msTo   = state.dateTo   ? new Date(state.dateTo   + 'T23:59:59').getTime() : null;
  const winStart = msFrom || (now - 30 * DAY);
  const winEnd   = msTo   || now;
  const days = Math.max(1, Math.ceil((winEnd - winStart) / DAY) + 1);

  // Update chart title dynamically
  const titleEl = $('timelineTitle');
  if (titleEl) {
    if (msFrom || msTo) {
      const fmt = ts => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      titleEl.textContent = `Tickets Activity — ${fmt(winStart)} to ${fmt(winEnd)}`;
    } else {
      titleEl.textContent = 'Tickets Activity — Last 30 Days';
    }
  }

  const buckets = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(winStart + i * DAY);
    const key = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    buckets[key] = { created: 0, closed: 0 };
  }

  state.filtered.forEach(t => {
    if (t.created && t.created >= winStart && t.created <= winEnd) {
      const d = new Date(t.created);
      const k = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (k in buckets) buckets[k].created++;
    }
    if (t.closed && t.closed >= winStart && t.closed <= winEnd) {
      const d = new Date(t.closed);
      const k = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (k in buckets) buckets[k].closed++;
    }
  });

  const labels   = Object.keys(buckets);
  const created  = labels.map(k => buckets[k].created);
  const closed   = labels.map(k => buckets[k].closed);

  // Show only every 5th label to avoid crowding
  const sparseLabels = labels.map((l, i) => i % 5 === 0 ? l : '');

  state.charts.timeline = new Chart($('timelineChart'), {
    type: 'line',
    data: {
      labels: sparseLabels,
      datasets: [
        {
          label: 'Created', data: created,
          borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)',
          pointRadius: 3, pointBackgroundColor: '#58a6ff', borderWidth: 2,
          fill: true, tension: 0.4
        },
        {
          label: 'Completed', data: closed,
          borderColor: '#3fb950', backgroundColor: 'rgba(63,185,80,0.1)',
          pointRadius: 3, pointBackgroundColor: '#3fb950', borderWidth: 2,
          fill: true, tension: 0.4
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#8b949e', font: { size: 11 }, boxWidth: 12 } },
        tooltip: {
          callbacks: {
            title: (items) => {
              // Use actual label from the full labels array
              return labels[items[0].dataIndex] || items[0].label;
            }
          }
        }
      },
      scales: {
        x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 }, maxRotation: 0 } },
        y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 11 }, stepSize: 1, precision: 0 }, beginAtZero: true }
      }
    }
  });
}

// ─── Render table ─────────────────────────────────────────
function renderTable() {
  const { filtered, page, pageSize } = state;
  const start = page * pageSize;
  const end   = Math.min(start + pageSize, filtered.length);
  const rows  = filtered.slice(start, end);

  $('ticketsCount').textContent = filtered.length;

  const tbody = $('ticketsBody');

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8" class="table-empty">${
      state.tasks.length ? 'No tickets match your filters.' : 'No tickets found.'
    }</td></tr>`;
    renderPagination();
    return;
  }

  tbody.innerHTML = rows.map((t, i) => {
    const due       = t.due ? fullDate(t.due) : '—';
    const dueC      = t.due ? dueClass(t.due, t.statusType) : 'date-none';
    const dueLabel  = dueC === 'date-overdue' ? `⚠ ${due}` : due;

    return `
      <tr>
        <td>${statusBadge(t.status, t.statusColor)}</td>
        <td>${priorityBadge(t.priority)}</td>
        <td class="request-cell">
          <div class="request-text" onclick="openModal(${start + i})" title="Click to view full description">
            ${escapeHtml(truncate(t.name, 120))}
          </div>
          <div class="request-source">via ${t.source}</div>
        </td>
        <td class="requester-cell" title="${escapeHtml(t.requester)}">${escapeHtml(t.requester)}</td>
        <td>${assigneeAvatars(t.assignees)}</td>
        <td class="date-cell" title="${fullDate(t.created)}">${relativeTime(t.created)}</td>
        <td class="date-cell ${dueC}">${dueLabel}</td>
        <td>
          <a href="${t.url}" target="_blank" rel="noopener noreferrer" class="btn-link" title="Open in ClickUp">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          </a>
        </td>
      </tr>`;
  }).join('');

  renderPagination();
}

function renderPagination() {
  const { filtered, page, pageSize } = state;
  const total = filtered.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = page * pageSize + 1;
  const end   = Math.min((page + 1) * pageSize, total);

  $('pageInfo').textContent  = total ? `${start}–${end} of ${total}` : '0 results';
  $('btnPrev').disabled = page === 0;
  $('btnNext').disabled = page >= totalPages - 1;
}

// ─── Sort headers ─────────────────────────────────────────
function initSortHeaders() {
  document.querySelectorAll('.th-sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (state.sortCol === col) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortCol = col;
        state.sortDir = 'desc';
      }
      document.querySelectorAll('.th-sortable').forEach(t => {
        t.classList.remove('sort-asc', 'sort-desc');
      });
      th.classList.add(`sort-${state.sortDir}`);
      sortTasks();
      renderTable();
    });
  });
}

// ─── Modal ────────────────────────────────────────────────
function openModal(idx) {
  const task = state.filtered[idx];
  if (!task) return;

  let backdrop = $('modalBackdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'modalBackdrop';
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <span class="modal-title" id="modalTitle">Ticket Details</span>
          <button class="modal-close" onclick="closeModal()">✕</button>
        </div>
        <div class="modal-body" id="modalBody"></div>
      </div>`;
    backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
    document.body.appendChild(backdrop);
  }

  $('modalTitle').textContent = task.requester;
  $('modalBody').textContent  = task.name;
  backdrop.classList.remove('hidden');
}

function closeModal() {
  const b = $('modalBackdrop');
  if (b) b.classList.add('hidden');
}

// ─── Auto-refresh ─────────────────────────────────────────
function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (state.autoRefresh) {
    state.refreshTimer = setTimeout(() => {
      fetchTickets();
      scheduleRefresh();
    }, 2 * 60 * 1000); // 2 minutes
  }
}

// ─── Utilities ────────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '…' : str;
}

// ─── Keyboard ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

// ─── Boot ─────────────────────────────────────────────────
function init() {
  // Wire up controls
  $('btnRefresh').addEventListener('click', () => fetchTickets(true));

  $('autoRefresh').addEventListener('change', function() {
    state.autoRefresh = this.checked;
    scheduleRefresh();
  });

  $('searchInput').addEventListener('input', () => { state.page = 0; applyFilters(); });
  $('statusFilter').addEventListener('change', () => { state.page = 0; applyFilters(); });
  $('priorityFilter').addEventListener('change', () => { state.page = 0; applyFilters(); });
  $('assigneeFilter').addEventListener('change', () => { state.page = 0; applyFilters(); });

  $('btnClearFilters').addEventListener('click', () => {
    $('searchInput').value = '';
    $('statusFilter').value = '';
    $('priorityFilter').value = '';
    $('assigneeFilter').value = '';
    $('dateFrom').value = '';
    $('dateTo').value   = '';
    state.cardFilter = null;
    state.activeCard = null;
    state.dateFrom   = null;
    state.dateTo     = null;
    Object.keys(CARD_FILTERS).forEach(id => {
      $$(`.metric-card#${id}`)?.classList.remove('card-active');
    });
    state.page = 0;
    applyFilters();
  });

  $('dateFrom').addEventListener('change', function () {
    state.dateFrom = this.value || null;
    state.page = 0;
    applyFilters();
  });
  $('dateTo').addEventListener('change', function () {
    state.dateTo = this.value || null;
    state.page = 0;
    applyFilters();
  });
  $('btnClearDates').addEventListener('click', () => {
    $('dateFrom').value = '';
    $('dateTo').value   = '';
    state.dateFrom = null;
    state.dateTo   = null;
    state.page = 0;
    applyFilters();
  });

  // Metric card click handlers
  Object.keys(CARD_FILTERS).forEach(id => {
    $(id)?.addEventListener('click', () => setActiveCard(id));
  });

  $('btnPrev').addEventListener('click', () => {
    if (state.page > 0) { state.page--; renderTable(); }
  });
  $('btnNext').addEventListener('click', () => {
    const total = state.filtered.length;
    if ((state.page + 1) * state.pageSize < total) { state.page++; renderTable(); }
  });

  initSortHeaders();

  // Initial load
  fetchTickets().then(() => scheduleRefresh());
}

// Set default sort header indicator
document.addEventListener('DOMContentLoaded', () => {
  const defaultTh = document.querySelector('[data-col="created"]');
  if (defaultTh) defaultTh.classList.add('sort-desc');
  init();
});
