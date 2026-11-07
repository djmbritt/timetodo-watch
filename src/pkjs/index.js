/*
 * TimeToDo phone-side logic (PebbleKit JS).
 *
 * Talks to the Todoist API v1 directly with the user's personal API token,
 * shows tasks in the watchapp, and puts them on the Pebble timeline.
 * Works with the Core Devices Pebble app and the Rebble app.
 */

var configPage = require('./config');
var todoist = require('./todoist');
var timeline = require('./timeline');
var u = require('./util');

var SETTINGS_KEY = 'timetodo-settings';
var REFRESH_MS = 5 * 60 * 1000;

// Must match src/c/main.c
var STATUS_OK = 0;
var STATUS_LOADING = 1;
var STATUS_NEEDS_CONFIG = 2;
var STATUS_ERROR = 3;

var ACTION_COMPLETE = 1;
var ACTION_TODAY = 2;
var ACTION_TOMORROW = 3;
var ACTION_WEEKEND = 4;
var ACTION_NEXT_WEEK = 5;

var FLAG_OVERDUE = 1;
var FLAG_RECURRING = 2;

var ID_BYTES = 23;
var TITLE_BYTES = 63;
var SUB_BYTES = 31;
var MAX_TASKS = 25;
var MAX_TIMELINE_FETCH = 100;

var lastTasks = [];
var fetching = false;
var refreshQueued = false;
var refreshTimer = null;

// ---------------------------------------------------------------------------
// Settings

function defaults() {
  return {
    token: '',
    filter: 'today | overdue',
    maxTasks: 20,
    showProject: true,
    clock24: true,
    timeline: true,
    timelineFilter: 'overdue | 7 days',
    pinReminders: false,
    syncInterval: 10,   // minutes between background syncs; 0 = only when opened, 1440 = daily
    pauseAtNight: true, // no background syncs from nightStart until nightEnd
    nightStart: 23,
    nightEnd: 7
  };
}

function loadSettings() {
  var s = defaults();
  try {
    var saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    for (var k in saved) {
      if (saved.hasOwnProperty(k)) {
        s[k] = saved[k];
      }
    }
  } catch (e) {
    console.log('Bad settings, using defaults: ' + e);
  }
  // v1.1 had syncMode (0 off, 1 daily, 2 twice daily, 3 every 4h) + syncHour.
  if (s.syncMode !== undefined) {
    // Mode 1 (once a day) was the v1.1 default, so it becomes the new default.
    s.syncInterval = [0, 10, 720, 240][s.syncMode] || 0;
    if (s.syncHour !== undefined) s.nightEnd = s.syncHour;
    delete s.syncMode;
    delete s.syncHour;
  }
  // v1.2 stored an active window (syncStart..syncEnd) instead of a night pause.
  if (s.syncStart !== undefined || s.syncEnd !== undefined) {
    var start = s.syncStart !== undefined ? +s.syncStart : 7;
    var end = s.syncEnd !== undefined ? +s.syncEnd : 23;
    s.pauseAtNight = start !== end;
    s.nightStart = end;
    s.nightEnd = start;
    delete s.syncStart;
    delete s.syncEnd;
  }
  return s;
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

// ---------------------------------------------------------------------------
// AppMessage queue (one message in flight at a time, with retries)

var queue = [];
var sending = false;

function send(dict) {
  queue.push({ dict: dict, tries: 0 });
  pump();
}

function pump() {
  if (sending || queue.length === 0) {
    return;
  }
  sending = true;
  var item = queue[0];
  Pebble.sendAppMessage(item.dict, function () {
    queue.shift();
    sending = false;
    pump();
  }, function () {
    item.tries++;
    sending = false;
    if (item.tries >= 3) {
      console.log('Dropping message after 3 tries: ' + JSON.stringify(item.dict));
      queue.shift();
    }
    setTimeout(pump, 300);
  });
}

function sendStatus(status, text) {
  send({ Status: status, StatusText: text || '' });
}

// The watch takes an active window [SyncStart, SyncEnd); start == end means
// all day. The night pause is the complement: active from nightEnd to nightStart.
function sendSchedule(settings) {
  var pause = settings.pauseAtNight && +settings.nightStart !== +settings.nightEnd;
  send({
    SyncInterval: settings.timeline && settings.token ? +settings.syncInterval : 0,
    SyncStart: pause ? +settings.nightEnd : 0,
    SyncEnd: pause ? +settings.nightStart : 0
  });
}

function sendSyncDone(err, result) {
  send(err ? { SyncDone: -1, StatusText: u.truncUtf8(String(err), 60) }
           : { SyncDone: result ? result.total : 0 });
}

// ---------------------------------------------------------------------------
// Refresh: task list for the watchapp + timeline pins

// Project names change rarely: cache them so background syncs need only one
// Todoist request.
var PROJECTS_KEY = 'timetodo-projects';
var PROJECTS_MAX_AGE = 6 * 60 * 60 * 1000;

function getProjects(token, allowCache, cb) {
  var cached = null;
  try {
    cached = JSON.parse(localStorage.getItem(PROJECTS_KEY) || 'null');
  } catch (e) {}
  if (allowCache && cached && cached.map && Date.now() - cached.at < PROJECTS_MAX_AGE) {
    return cb(cached.map);
  }
  todoist.fetchProjects(token, function (map) {
    if (Object.keys(map).length) {
      localStorage.setItem(PROJECTS_KEY, JSON.stringify({ at: Date.now(), map: map }));
      cb(map);
    } else {
      cb((cached && cached.map) || {});
    }
  });
}

/*
 * background = true for a scheduled wakeup: only update the timeline, as fast
 * as possible, and skip the task list (the watch closes on SyncDone).
 */
function refresh(background) {
  if (fetching) {
    refreshQueued = true;
    return;
  }
  var settings = loadSettings();
  if (!settings.token) {
    lastTasks = [];
    sendStatus(STATUS_NEEDS_CONFIG);
    timeline.sync(null, {}, settings, sendSyncDone); // clear any old pins
    return;
  }
  fetching = true;

  if (background) {
    getProjects(settings.token, true, function (projects) {
      syncTimeline(settings, projects, null, done);
    });
    return;
  }

  sendStatus(STATUS_LOADING);

  var projects = null;
  var listTasks = null;
  var listErr = null;
  var pending = 2;

  getProjects(settings.token, false, function (map) {
    projects = map;
    step();
  });
  todoist.fetchFilter(settings.token, settings.filter || 'today | overdue', MAX_TASKS * 2, function (err, list) {
    listErr = err;
    listTasks = list;
    step();
  });

  function step() {
    if (--pending > 0) {
      return;
    }
    if (listErr) {
      sendStatus(STATUS_ERROR, listErr);
    } else {
      listTasks.forEach(function (t) { t._due = u.parseDue(t.due); });
      u.sortTasks(listTasks);
      lastTasks = listTasks.slice(0, Math.min(settings.maxTasks || 20, MAX_TASKS));
      sendTasks(lastTasks, projects, settings);
    }
    syncTimeline(settings, projects, listErr ? null : listTasks, done);
  }

}

function done() {
  fetching = false;
  if (refreshQueued) {
    refreshQueued = false;
    refresh(false);
  }
}

function syncTimeline(settings, projects, listTasks, cb) {
  if (!settings.timeline) {
    timeline.sync(null, projects, settings, function (err, res) {
      sendSyncDone(err, res);
      cb();
    });
    return;
  }
  var query = settings.timelineFilter || 'overdue | 7 days';
  function withTasks(err, tasks) {
    if (err) {
      // Never delete pins because of a failed fetch.
      sendSyncDone(err);
      return cb();
    }
    tasks.forEach(function (t) { t._due = t._due || u.parseDue(t.due); });
    timeline.sync(tasks, projects, settings, function (syncErr, res) {
      console.log('Timeline: ' + JSON.stringify(res) + (syncErr ? ' error: ' + syncErr : ''));
      sendSyncDone(syncErr, res);
      cb();
    });
  }
  if (listTasks && query === settings.filter && listTasks.length < MAX_TASKS * 2) {
    withTasks(null, listTasks.slice());
  } else {
    todoist.fetchFilter(settings.token, query, MAX_TIMELINE_FETCH, withTasks);
  }
}

function sendTasks(tasks, projects, settings) {
  send({ TaskCount: tasks.length });
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i];
    var due = u.describeDue(t._due, settings.clock24);
    var parts = [];
    if (due.label) parts.push(due.label);
    if (settings.showProject && projects[t.project_id]) parts.push(u.oneLine(projects[t.project_id]));
    var flags = (due.overdue ? FLAG_OVERDUE : 0) | (t.due && t.due.is_recurring ? FLAG_RECURRING : 0);
    send({
      TaskIndex: i,
      TaskId: u.truncUtf8(String(t.id), ID_BYTES),
      TaskTitle: u.truncUtf8(u.oneLine(t.content) || '(untitled)', TITLE_BYTES),
      TaskSub: u.truncUtf8(parts.join(' · '), SUB_BYTES),
      TaskPrio: t.priority || 1,
      TaskFlags: flags
    });
  }
}

// ---------------------------------------------------------------------------
// Actions

function targetDate(action) {
  var today = u.startOfDay(new Date());
  var dow = today.getDay();
  var add;
  switch (action) {
    case ACTION_TODAY: add = 0; break;
    case ACTION_TOMORROW: add = 1; break;
    case ACTION_WEEKEND: add = (6 - dow + 7) % 7 || 7; break;  // next Saturday
    case ACTION_NEXT_WEEK: add = (8 - dow) % 7 || 7; break;    // next Monday
    default: return null;
  }
  return u.addDays(today, add);
}

function findTask(id) {
  for (var i = 0; i < lastTasks.length; i++) {
    if (String(lastTasks[i].id) === id) {
      return lastTasks[i];
    }
  }
  return null;
}

function runAction(action, id) {
  var settings = loadSettings();
  if (!settings.token) {
    sendStatus(STATUS_NEEDS_CONFIG);
    return;
  }
  function finished(err) {
    if (err) {
      send({ ActionResult: 0, StatusText: err });
    } else {
      send({ ActionResult: 1 });
    }
    refresh(false);
  }
  if (action === ACTION_COMPLETE) {
    todoist.closeTask(settings.token, id, finished);
    return;
  }
  var date = targetDate(action);
  if (!date) {
    return;
  }
  var task = findTask(id);
  var at = task && task._due && task._due.at;
  var fields;
  if (at) {
    // Keep the task's time of day on the new date.
    var moved = new Date(date.getFullYear(), date.getMonth(), date.getDate(), at.getHours(), at.getMinutes());
    fields = { due_datetime: moved.toISOString().replace(/\.\d{3}Z$/, 'Z') };
  } else {
    fields = { due_date: u.ymd(date) };
  }
  todoist.updateTask(settings.token, id, fields, finished);
}

// ---------------------------------------------------------------------------
// Pebble events

// The watch answers our first message with Hello (1 = background sync).
// Older watch builds don't, so fall back to a normal refresh.
var started = false;
var helloTimer = null;

function start(background) {
  if (started) {
    return;
  }
  started = true;
  clearTimeout(helloTimer);
  refresh(background);
  if (!background) {
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }
    refreshTimer = setInterval(function () { refresh(false); }, REFRESH_MS);
  }
}

Pebble.addEventListener('ready', function () {
  sendSchedule(loadSettings());
  helloTimer = setTimeout(function () { start(false); }, 2500);
});

Pebble.addEventListener('appmessage', function (e) {
  var p = e.payload || {};
  if (p.Hello !== undefined) {
    if (p.Action !== undefined && p.LaunchCode !== undefined) {
      started = true;   // runAction refreshes when done
      clearTimeout(helloTimer);
      completeFromPin(+p.LaunchCode);
      return;
    }
    start(+p.Hello === 1);
    return;
  }
  if (p.Action !== undefined && p.LaunchCode !== undefined) {
    // "Complete" chosen on a timeline pin (Rebble app)
    completeFromPin(+p.LaunchCode);
  } else if (p.Action !== undefined && p.TaskId !== undefined) {
    runAction(+p.Action, String(p.TaskId));
  } else if (p.Refresh !== undefined) {
    if (!started) {
      start(false);
    } else {
      refresh(false);
    }
  }
});

function completeFromPin(code) {
  var id = timeline.taskIdForCode(code);
  if (id) {
    runAction(ACTION_COMPLETE, id);
  } else {
    send({ ActionResult: 0, StatusText: 'Task no longer on timeline' });
    refresh(false);
  }
}

Pebble.addEventListener('showConfiguration', function () {
  Pebble.openURL(configPage.url(loadSettings(), timeline.hasLocalApi()));
});

Pebble.addEventListener('webviewclosed', function (e) {
  if (!e || !e.response || e.response === 'CANCELLED') {
    return;
  }
  var data;
  try {
    data = JSON.parse(decodeURIComponent(e.response));
  } catch (err) {
    console.log('Could not parse settings: ' + err);
    return;
  }
  var s = loadSettings();
  var d = defaults();
  if (data.clearToken) {
    s.token = '';
  } else if (data.token) {
    s.token = String(data.token).replace(/\s+/g, '');
  }
  if (typeof data.filter === 'string') s.filter = data.filter.trim() || d.filter;
  if (data.maxTasks) s.maxTasks = Math.max(5, Math.min(MAX_TASKS, +data.maxTasks || 20));
  if (typeof data.showProject === 'boolean') s.showProject = data.showProject;
  if (typeof data.clock24 === 'boolean') s.clock24 = data.clock24;
  if (typeof data.timeline === 'boolean') s.timeline = data.timeline;
  if (typeof data.timelineFilter === 'string') s.timelineFilter = data.timelineFilter.trim() || d.timelineFilter;
  if (typeof data.pinReminders === 'boolean') s.pinReminders = data.pinReminders;
  if (data.syncInterval !== undefined) {
    var iv = +data.syncInterval || 0;
    s.syncInterval = iv <= 0 ? 0 : Math.max(5, Math.min(1440, iv));
  }
  if (typeof data.pauseAtNight === 'boolean') s.pauseAtNight = data.pauseAtNight;
  if (data.nightStart !== undefined) s.nightStart = Math.max(0, Math.min(23, +data.nightStart || 0));
  if (data.nightEnd !== undefined) s.nightEnd = Math.max(0, Math.min(23, +data.nightEnd || 0));
  saveSettings(s);
  sendSchedule(s);
  refresh(false);
});
