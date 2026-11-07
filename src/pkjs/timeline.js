/*
 * Puts Todoist tasks on the Pebble timeline.
 *
 * - Core Devices Pebble app: Pebble.insertTimelinePin()/deleteTimelinePin()
 *   (local pins; no server or timeline token involved).
 * - Rebble / original Pebble app: PUT/DELETE to the Rebble timeline web API
 *   with the app's timeline token, straight from the phone.
 *
 * Pins can only be written while this JavaScript runs (i.e. while the app is
 * open on the watch), which is why the watch app wakes itself on a schedule.
 *
 * Only pins that changed are re-sent; tasks that disappear from the filter
 * (completed, deleted, moved out of range) have their pins removed.
 */

var u = require('./util');

var STATE_KEY = 'timetodo-pins';
var WEB_API = 'https://timeline-api.rebble.io/v1/user/pins/';
var MAX_PINS = 60;
var RESEND_MS = 24 * 60 * 60 * 1000;   // re-send unchanged pins once a day
var PRIORITY_NAMES = { 4: 'P1 · Urgent', 3: 'P2 · High', 2: 'P3 · Medium', 1: 'P4' };

function loadState() {
  try {
    var s = JSON.parse(localStorage.getItem(STATE_KEY) || 'null');
    if (s && s.v === 1 && s.pins) {
      return s;
    }
  } catch (e) {}
  return { v: 1, pins: {}, gen: {}, codes: {}, nextCode: 1 };
}

function saveState(s) {
  localStorage.setItem(STATE_KEY, JSON.stringify(s));
}

function hasLocalApi() {
  return typeof Pebble.insertTimelinePin === 'function' && typeof Pebble.deleteTimelinePin === 'function';
}

// --- transport --------------------------------------------------------------

var tokenCache = null;
var tokenError = null;   // reset each sync so one failure doesn't repeat per pin

function getTimelineToken(cb) {
  if (tokenCache) {
    return cb(null, tokenCache);
  }
  if (tokenError) {
    return cb(tokenError);
  }
  if (typeof Pebble.getTimelineToken !== 'function') {
    tokenError = 'Timeline not supported by this phone app';
    return cb(tokenError);
  }
  Pebble.getTimelineToken(function (token) {
    tokenCache = token;
    cb(null, token);
  }, function (err) {
    tokenError = 'No timeline token (' + err + ')';
    cb(tokenError);
  });
}

function webApi(method, id, pin, cb) {
  getTimelineToken(function (err, token) {
    if (err) {
      return cb(err);
    }
    var xhr = new XMLHttpRequest();
    xhr.onload = function () {
      // 410 = app removed from this account; treat 404 on delete as success
      if ((xhr.status >= 200 && xhr.status < 300) || (method === 'DELETE' && xhr.status === 404)) {
        cb(null);
      } else {
        cb('Timeline API ' + xhr.status);
      }
    };
    xhr.onerror = function () { cb('No connection'); };
    xhr.open(method, WEB_API + encodeURIComponent(id), true);
    xhr.setRequestHeader('X-User-Token', token);
    if (pin) {
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(pin));
    } else {
      xhr.send();
    }
  });
}

function insertPin(pin, cb) {
  if (hasLocalApi()) {
    try {
      Pebble.insertTimelinePin(pin);
      cb(null);
    } catch (e) {
      cb('Insert failed: ' + e);
    }
  } else {
    webApi('PUT', pin.id, pin, cb);
  }
}

function deletePin(id, cb) {
  if (hasLocalApi()) {
    try {
      Pebble.deleteTimelinePin(id);
      cb(null);
    } catch (e) {
      cb('Delete failed: ' + e);
    }
  } else {
    webApi('DELETE', id, null, cb);
  }
}

// Run fn(item, next) over items one at a time.
function series(items, fn, done) {
  var i = 0;
  (function step() {
    if (i >= items.length) {
      return done();
    }
    var item = items[i++];
    fn(item, function () { setTimeout(step, 0); });
  })();
}

// --- pin building -----------------------------------------------------------

/*
 * Timed tasks sit at their time (with their Todoist duration if set).
 * Date-only tasks become "All day" pins: local midnight + 1440 minutes, which
 * the watch renders as an all-day item at the top of that day.
 * Overdue tasks are pulled forward to today so they stay visible.
 */
function buildPin(task, pinId, code, projects, settings, now) {
  var due = task._due;
  var today = u.startOfDay(now);
  var overdueDays = due.date < today;
  var allDay = !due.at || overdueDays;
  var time, duration;

  if (allDay) {
    time = overdueDays ? today : due.date;
    duration = 24 * 60;
  } else {
    time = due.at;
    if (task.duration && task.duration.amount > 0) {
      duration = task.duration.unit === 'day' ? task.duration.amount * 1440 : task.duration.amount;
    }
  }

  var project = projects[task.project_id] ? u.oneLine(projects[task.project_id]) : '';
  var subtitle = overdueDays ? 'Overdue since ' + u.shortDate(due.date) : project;

  var headings = [];
  var paragraphs = [];
  if (overdueDays && project) {
    headings.push('Project');
    paragraphs.push(project);
  }
  if (task.priority > 1) {
    headings.push('Priority');
    paragraphs.push(PRIORITY_NAMES[task.priority]);
  }
  if (task.due && task.due.string) {
    headings.push(task.due.is_recurring ? 'Repeats' : 'Due');
    paragraphs.push(u.oneLine(task.due.string));
  }
  if (task.labels && task.labels.length) {
    headings.push('Labels');
    paragraphs.push(task.labels.map(function (l) { return '@' + l; }).join(' '));
  }

  // calendarPin (not genericPin): its detail card says "All day" for all-day
  // pins and shows "start – end" for timed tasks with a duration, where the
  // generic card would print "12:00 AM".
  var layout = {
    type: 'calendarPin',
    title: u.truncUtf8(u.oneLine(task.content) || '(untitled)', 120),
    tinyIcon: task.priority === 4 ? 'system://images/NOTIFICATION_REMINDER' : 'system://images/NOTIFICATION_FLAG'
  };
  if (subtitle) {
    layout.locationName = u.truncUtf8(subtitle, 60);
  }
  var body = u.cleanText(task.description);
  if (body) {
    layout.body = u.truncUtf8(body, 500);
  }
  if (headings.length) {
    layout.headings = headings;
    layout.paragraphs = paragraphs.map(function (p) { return u.truncUtf8(p, 200); });
  }

  var pin = {
    id: pinId,
    time: time.toISOString(),
    layout: layout,
    // Honoured by the Rebble app; the Core app replaces actions with "Remove".
    actions: [{ title: 'Complete', type: 'openWatchApp', launchCode: code }]
  };
  if (duration) {
    pin.duration = duration;
  }
  if (settings.pinReminders && !allDay && due.at > now) {
    pin.reminders = [{
      time: due.at.toISOString(),
      layout: { type: 'genericReminder', title: layout.title, tinyIcon: layout.tinyIcon }
    }];
  }
  return pin;
}

// --- sync -------------------------------------------------------------------

/*
 * tasks: Todoist tasks (already given _due via util.parseDue), or null to
 * remove every pin (timeline turned off / signed out).
 * cb(err, {inserted, deleted, total})
 */
function sync(tasks, projects, settings, cb) {
  var state = loadState();
  var now = new Date();
  var wanted = {};
  tokenError = null;
  var toInsert = [];
  var toDelete = [];

  var list = (tasks || []).filter(function (t) { return t._due; });
  u.sortTasks(list);
  list = list.slice(0, MAX_PINS);

  list.forEach(function (task) {
    var id = String(task.id);
    var entry = state.pins[id];
    if (!entry) {
      var gen = state.gen[id] || 0;
      entry = { pid: 'todoist-' + id + (gen ? '-' + gen : ''), code: state.nextCode++, hash: '', at: 0 };
      if (state.nextCode > 0x7fffffff) {
        state.nextCode = 1;
      }
    }
    var pin = buildPin(task, entry.pid, entry.code, projects || {}, settings, now);
    var h = u.hash(JSON.stringify(pin));
    if (h !== entry.hash || now - entry.at > RESEND_MS) {
      toInsert.push({ id: id, entry: entry, pin: pin, hash: h });
    }
    wanted[id] = entry;
  });

  Object.keys(state.pins).forEach(function (id) {
    if (!wanted[id]) {
      toDelete.push({ id: id, entry: state.pins[id] });
    }
  });

  var firstErr = null;
  var inserted = 0, deleted = 0;

  series(toDelete, function (item, next) {
    deletePin(item.entry.pid, function (err) {
      if (err && !firstErr) firstErr = err;
      if (!err) {
        deleted++;
        // A deleted pin id may not be reusable; bump the generation.
        state.gen[item.id] = (state.gen[item.id] || 0) + 1;
        delete state.pins[item.id];
      }
      next();
    });
  }, function () {
    series(toInsert, function (item, next) {
      insertPin(item.pin, function (err) {
        if (err && !firstErr) firstErr = err;
        if (!err) {
          inserted++;
          item.entry.hash = item.hash;
          item.entry.at = now.getTime();
        }
        next();
      });
    }, function () {
      Object.keys(wanted).forEach(function (id) {
        // Keep entries whose insert failed too, so the next sync retries them.
        state.pins[id] = wanted[id];
      });
      state.codes = {};
      Object.keys(state.pins).forEach(function (id) {
        state.codes[state.pins[id].code] = id;
      });
      saveState(state);
      cb(firstErr, { inserted: inserted, deleted: deleted, total: Object.keys(state.pins).length });
    });
  });
}

// Task id for a pin's "Complete" launch code (Rebble app pin actions).
function taskIdForCode(code) {
  return loadState().codes[code] || null;
}

module.exports = {
  sync: sync,
  buildPin: buildPin,
  taskIdForCode: taskIdForCode,
  hasLocalApi: hasLocalApi
};
