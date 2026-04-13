require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.CLICKUP_API_KEY;

if (!API_KEY) {
  console.error('ERROR: CLICKUP_API_KEY is not set in .env');
  process.exit(1);
}

// ClickUp API client
const clickup = axios.create({
  baseURL: 'https://api.clickup.com/api/v2',
  headers: { Authorization: API_KEY }
});

// --- IDs ---
const SPACE_ID  = '90020081402'; // IT and Data Space
const FOLDER_ID = '90060377908'; // Tickets folder
const LIST_FORM = '901407592487'; // Form (live submissions)
const LIST_V2   = '901407592075'; // Tickets V2

// Simple in-memory cache to avoid hammering the ClickUp API
let _cache     = null;
let _cacheTime = 0;
const CACHE_TTL = 60 * 1000; // 60 seconds

app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

async function getAllTasksFromList(listId) {
  const tasks = [];
  let page = 0;
  while (true) {
    const { data } = await clickup.get(`/list/${listId}/task`, {
      params: {
        page,
        include_closed: true,
        subtasks: true
      }
    });
    tasks.push(...(data.tasks || []));
    if (data.last_page) break;
    page++;
  }
  return tasks;
}

function normalizeTask(task, source) {
  const emailField = (task.custom_fields || []).find(f => f.name === 'Email');
  const requester  = emailField?.value
    || (task.creator?.id !== -1 ? (task.creator?.email || task.creator?.username) : null)
    || 'Unknown';

  return {
    id:            task.id,
    url:           task.url,
    // Form tasks use name = email, text_content = actual request
    name:          task.text_content || task.name || '(no description)',
    rawName:       task.name,
    requester,
    status:        task.status?.status      || 'unknown',
    statusColor:   task.status?.color       || '#87909e',
    statusType:    task.status?.type        || 'open',
    priority:      task.priority?.priority  || 'none',
    priorityColor: task.priority?.color     || '#87909e',
    priorityOrder: task.priority ? parseInt(task.priority.orderindex, 10) : 99,
    assignees:     (task.assignees || []).map(a => ({
      name:     a.username || a.email || '?',
      color:    a.color    || '#87909e',
      initials: a.initials || (a.username ? a.username.slice(0, 2).toUpperCase() : '?')
    })),
    created: task.date_created ? parseInt(task.date_created, 10) : null,
    updated: task.date_updated ? parseInt(task.date_updated, 10) : null,
    closed:  task.date_closed  ? parseInt(task.date_closed,  10) : null,
    due:     task.due_date     ? parseInt(task.due_date,     10) : null,
    source,
    tags: (task.tags || []).map(t => t.name)
  };
}

// -------------------------------------------------------
// Routes
// -------------------------------------------------------

// GET /api/tickets — all tasks from the Tickets folder
app.get('/api/tickets', async (req, res) => {
  try {
    const force = req.query.force === 'true';
    if (!force && _cache && Date.now() - _cacheTime < CACHE_TTL) {
      return res.json(_cache);
    }

    const [formTasks, v2Tasks] = await Promise.all([
      getAllTasksFromList(LIST_FORM),
      getAllTasksFromList(LIST_V2)
    ]);

    const tasks = [
      ...formTasks.map(t => normalizeTask(t, 'Form')),
      ...v2Tasks.map(  t => normalizeTask(t, 'Tickets V2'))
    ].sort((a, b) => (b.created || 0) - (a.created || 0));

    const payload = {
      success:   true,
      tasks,
      total:     tasks.length,
      fetchedAt: Date.now(),
      lists: {
        form:      formTasks.length,
        ticketsV2: v2Tasks.length
      }
    };

    _cache     = payload;
    _cacheTime = Date.now();

    res.json(payload);
  } catch (err) {
    console.error('ClickUp API error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/members — space members
app.get('/api/members', async (req, res) => {
  try {
    const { data } = await clickup.get(`/space/${SPACE_ID}`);
    res.json({ success: true, members: data.members || [] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Catch-all → serve the dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  RBO IT Ticket Dashboard`);
  console.log(`  ► http://localhost:${PORT}\n`);
});
