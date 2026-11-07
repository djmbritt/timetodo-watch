/* Shared text and date helpers. */

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Truncate to a byte budget without splitting a UTF-8 sequence.
function truncUtf8(str, maxBytes) {
  var bytes = 0;
  var out = '';
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    var n = c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
    if (bytes + n > maxBytes) {
      // Leave room for an ellipsis (3 bytes) if we cut the string.
      while (bytes + 3 > maxBytes && out.length) {
        var last = out.charCodeAt(out.length - 1);
        bytes -= last < 0x80 ? 1 : last < 0x800 ? 2 : 3;
        out = out.slice(0, -1);
      }
      return out.replace(/\s+$/, '') + '…';
    }
    bytes += n;
    out += str.charAt(i);
  }
  return out;
}

// Pebble fonts can't draw emoji or Markdown, so clean text up.
function cleanText(str) {
  return String(str || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')      // [text](url) -> text
    .replace(/(\*\*|__|`|~~)/g, '')                 // bold/code/strike markers
    .replace(/[\uD800-\uDFFF]/g, '')               // emoji & other astral chars
    .replace(/[☀-➿️‍]/g, '')   // misc symbols, variation selectors
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/^\s+|\s+$/g, '');
}

function oneLine(str) {
  return cleanText(str).replace(/\s+/g, ' ');
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatTime(d, clock24) {
  if (clock24) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  var h = d.getHours() % 12 || 12;
  return h + ':' + pad2(d.getMinutes()) + (d.getHours() < 12 ? 'am' : 'pm');
}

function shortDate(d) {
  return d.getDate() + ' ' + MONTHS[d.getMonth()];
}

function ymd(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// Parse a Todoist due object into { date: Date (local midnight), at: Date|null }.
// Handles "2026-10-16", floating "2026-10-16T14:00:00" and UTC "...Z".
function parseDue(due) {
  if (!due) {
    return null;
  }
  var raw = due.datetime || due.date;
  if (!raw) {
    return null;
  }
  var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z)?)?/.exec(raw);
  if (!m) {
    return null;
  }
  var at = null;
  if (m[4] !== undefined) {
    if (m[7]) {
      at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
    } else {
      at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    }
  }
  var date = at ? startOfDay(at) : new Date(+m[1], +m[2] - 1, +m[3]);
  return { date: date, at: at };
}

function describeDue(parsed, clock24, now) {
  if (!parsed) {
    return { label: '', overdue: false };
  }
  now = now || new Date();
  var today = startOfDay(now);
  var days = Math.round((parsed.date - today) / 86400000);
  var time = parsed.at ? ' ' + formatTime(parsed.at, clock24) : '';
  var overdue = days < 0 || (parsed.at !== null && parsed.at < now);
  var label;
  if (days < 0) {
    label = 'Overdue · ' + shortDate(parsed.date);
  } else if (days === 0) {
    label = (overdue ? 'Overdue' : 'Today') + time;
  } else if (days === 1) {
    label = 'Tomorrow' + time;
  } else if (days < 7) {
    label = DAYS[parsed.date.getDay()] + time;
  } else {
    label = shortDate(parsed.date) + time;
  }
  return { label: label, overdue: overdue };
}

function sortTasks(tasks) {
  tasks.sort(function (a, b) {
    var ad = a._due, bd = b._due;
    if (!ad && bd) return 1;
    if (ad && !bd) return -1;
    if (ad && bd) {
      if (+ad.date !== +bd.date) return ad.date - bd.date;
      // Timed tasks first within a day, in time order
      if (ad.at && !bd.at) return -1;
      if (!ad.at && bd.at) return 1;
      if (ad.at && bd.at && +ad.at !== +bd.at) return ad.at - bd.at;
    }
    if (a.priority !== b.priority) return b.priority - a.priority;
    return (a.child_order || 0) - (b.child_order || 0);
  });
  return tasks;
}

// Small stable string hash (djb2) to detect changed pins.
function hash(str) {
  var h = 5381;
  for (var i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

module.exports = {
  truncUtf8: truncUtf8,
  cleanText: cleanText,
  oneLine: oneLine,
  formatTime: formatTime,
  shortDate: shortDate,
  ymd: ymd,
  startOfDay: startOfDay,
  addDays: addDays,
  parseDue: parseDue,
  describeDue: describeDue,
  sortTasks: sortTasks,
  hash: hash
};
