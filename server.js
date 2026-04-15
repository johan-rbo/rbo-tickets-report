require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app     = express();
const PORT    = process.env.PORT || 3000;
const API_KEY = process.env.CLICKUP_API_KEY;

if (!API_KEY) {
  console.error('ERROR: CLICKUP_API_KEY is not set in .env');
  process.exit(1);
}

const clickup = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: API_KEY }
});

// --- IDs ---
const SPACE_ID  = '90020081402';
const FOLDER_ID = '90060377908';
const LIST_FORM = '901407592487';
const LIST_V2   = '901407592075';

// --- Cache & SSE state ---
let _cache     = null;
let _cacheTime = 0;
let _clients   = [];           // active SSE connections

const CACHE_TTL     = 60 * 1_000;   // 1 min cache for manual requests
const POLL_INTERVAL = 30 * 1_000;   // push updates every 30 s

app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────

async function getAllTasksFromList(listId) {
  const tasks = [];
  let page = 0;
  while (true) {
    const { data } = await clickup.get(`/list/${listId}/task`, {
      params: { page, include_closed: true, subtasks: true }
    });
    tasks.push(...(data.tasks || []));
    if (data.last_page) break;
    page++;
  }
  return tasks;
}

// Resolve display name: prefer username if it looks like a real name,
// otherwise derive from email (handles "jose.garcia@rbo.team" → "Jose Garcia")
function resolveAssigneeName(a) {
  const username = (a.username || '').trim();
  if (username && !username.includes('@')) return username;
  const email = (a.email || '').trim();
  if (email) {
    return email
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  return username || '?';
}

function resolveInitials(a) {
  if (a.initials) return a.initials.toUpperCase();
  const name = resolveAssigneeName(a);
  const parts = name.trim().split(/\s+/);
  return parts.length === 1
    ? parts[0].slice(0, 2).toUpperCase()
    : (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function normalizeTask(task, source) {
  const emailField = (task.custom_fields || []).find(f => f.name === 'Email');
  const requester  = emailField?.value
    || (task.creator?.id !== -1 ? (task.creator?.email || task.creator?.username) : null)
    || 'Unknown';

  return {
    id:            task.id,
    url:           task.url,
    name:          task.text_content || task.name || '(no description)',
    rawName:       task.name,
    requester,
    status:        task.status?.status      || 'unknown',
    statusColor:   task.status?.color       || '#87909e',
    statusType:    task.status?.type        || 'open',
    priority:      task.priority?.priority  || 'none',
    priorityColor: task.priority?.color     || '#87909e',
    priorityOrder: task.priority ? parseInt(task.priority.orderindex, 10) : 99,
    assignees: (task.assignees || []).map(a => ({
      name:     resolveAssigneeName(a),
      color:    a.color || '#87909e',
      initials: resolveInitials(a)
    })),
    created: task.date_created ? parseInt(task.date_created, 10) : null,
    updated: task.date_updated ? parseInt(task.date_updated, 10) : null,
    closed:  task.date_closed  ? parseInt(task.date_closed,  10) : null,
    due:     task.due_date     ? parseInt(task.due_date,     10) : null,
    source,
    tags: (task.tags || []).map(t => t.name)
  };
}

async function fetchAndCacheTickets(force = false) {
  if (!force && _cache && Date.now() - _cacheTime < CACHE_TTL) {
    return _cache;
  }

  const [formTasks, v2Tasks] = await Promise.all([
    getAllTasksFromList(LIST_FORM),
    getAllTasksFromList(LIST_V2)
  ]);

  const tasks = [
    ...formTasks.map(t => normalizeTask(t, 'Form')),
    ...v2Tasks.map(t  => normalizeTask(t, 'Tickets V2'))
  ].sort((a, b) => (b.created || 0) - (a.created || 0));

  const payload = {
    success:   true,
    tasks,
    total:     tasks.length,
    fetchedAt: Date.now(),
    lists: { form: formTasks.length, ticketsV2: v2Tasks.length }
  };

  _cache     = payload;
  _cacheTime = Date.now();
  return payload;
}

// Push latest data to all connected SSE clients
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  _clients = _clients.filter(res => {
    try { res.write(msg); return true; } catch { return false; }
  });
}

// Poll ClickUp every POLL_INTERVAL and broadcast to clients
function startBackgroundPolling() {
  setInterval(async () => {
    try {
      const data = await fetchAndCacheTickets(true);
      broadcast(data);
    } catch (e) {
      console.error('Background poll error:', e.message);
    }
  }, POLL_INTERVAL);
}

// ── Routes ────────────────────────────────────────────────

// Real-time stream — clients connect once and receive pushes
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Send current cache immediately so the page loads without waiting
  if (_cache) res.write(`data: ${JSON.stringify(_cache)}\n\n`);

  _clients.push(res);
  req.on('close', () => { _clients = _clients.filter(c => c !== res); });
});

// Manual / fallback fetch
app.get('/api/tickets', async (req, res) => {
  try {
    const data = await fetchAndCacheTickets(req.query.force === 'true');
    res.json(data);
  } catch (err) {
    console.error('ClickUp API error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/members', async (req, res) => {
  try {
    const { data } = await clickup.get(`/space/${SPACE_ID}`);
    res.json({ success: true, members: data.members || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, async () => {
  console.log(`\n  RBO IT Ticket Dashboard`);
  console.log(`  ► http://localhost:${PORT}\n`);
  // Pre-warm cache before accepting SSE clients
  try { await fetchAndCacheTickets(true); } catch (e) { console.error('Initial fetch error:', e.message); }
  startBackgroundPolling();
});
