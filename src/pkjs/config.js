/*
 * Settings page, served as a data: URI so it works offline and in both the
 * Rebble and Core Devices phone apps. The token is never echoed back into
 * the page; leaving the field blank keeps the saved one.
 */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function options(list, selected) {
  return list.map(function (o) {
    return '<option value="' + o[0] + '"' + (+o[0] === +selected ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');
}

function checkbox(id, label, checked) {
  return '<div class="row"><label for="' + id + '">' + label + '</label><input id="' + id +
    '" type="checkbox"' + (checked ? ' checked' : '') + '></div>';
}

function url(settings, localPins) {
  var counts = [5, 10, 15, 20, 25].map(function (n) { return [n, n]; });
  var hours = [];
  for (var h = 0; h < 24; h++) {
    hours.push([h, (h < 10 ? '0' : '') + h + ':00']);
  }
  var intervals = [
    [5, 'Every 5 minutes'],
    [10, 'Every 10 minutes'],
    [15, 'Every 15 minutes'],
    [30, 'Every 30 minutes'],
    [60, 'Every hour'],
    [240, 'Every 4 hours'],
    [1440, 'Once a day'],
    [0, 'Only when I open the app']
  ];

  var html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>TimeToDo</title><style>' +
    'body{font-family:-apple-system,Roboto,Helvetica,sans-serif;margin:0;background:#f4f4f4;color:#202020}' +
    'header{background:#db4c3f;color:#fff;padding:18px 16px}h1{margin:0;font-size:22px}' +
    'header p{margin:4px 0 0;opacity:.9;font-size:14px}' +
    'h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#777;margin:18px 16px 0}' +
    'section{background:#fff;margin:8px 12px 12px;border-radius:10px;padding:6px 16px 12px}' +
    'label{display:block;font-weight:600;font-size:14px;margin:10px 0 6px}' +
    'input[type=text],input[type=password],select{width:100%;box-sizing:border-box;font-size:16px;' +
    'padding:10px;border:1px solid #ccc;border-radius:8px;background:#fff}' +
    '.hint{font-size:13px;color:#666;margin-top:6px;line-height:1.4}' +
    '.row{display:flex;align-items:center;justify-content:space-between;margin:12px 0;gap:12px}' +
    '.row label{margin:0;font-weight:500}input[type=checkbox]{width:22px;height:22px;flex:none}' +
    '.ok{color:#2e7d32;font-size:13px;margin-top:6px}' +
    'code{background:#f0f0f0;padding:1px 4px;border-radius:4px}' +
    'button{width:calc(100% - 24px);margin:4px 12px 24px;font-size:17px;padding:14px;border:0;' +
    'border-radius:10px;background:#db4c3f;color:#fff;font-weight:600}' +
    '</style></head><body>' +
    '<header><h1>TimeToDo</h1><p>Your Todoist tasks on your Pebble and its timeline</p></header>' +

    '<h2>Todoist</h2><section>' +
    '<label for="token">API token</label>' +
    '<input id="token" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="' +
    (settings.token ? 'Saved (leave blank to keep)' : 'Paste your token') + '">' +
    (settings.token ? '<div class="ok">A token is saved.</div>' : '') +
    '<div class="hint">In Todoist: Settings → Integrations → Developer → API token. ' +
    'It stays on your phone and is only sent to api.todoist.com.</div>' +
    (settings.token ? checkbox('clear', 'Remove saved token (also clears pins)', false) : '') +
    '</section>' +

    '<h2>Timeline</h2><section>' +
    checkbox('tl', 'Put tasks on the timeline', settings.timeline) +
    '<label for="tlfilter">Which tasks</label>' +
    '<input id="tlfilter" type="text" autocapitalize="off" value="' + esc(settings.timelineFilter) + '">' +
    '<div class="hint">Tasks with a time appear at that time; tasks with only a date appear as ' +
    '“All day”; overdue ones are moved to today. Default <code>overdue | 7 days</code>.</div>' +
    '<label for="iv">Sync in the background</label><select id="iv">' + options(intervals, settings.syncInterval) + '</select>' +
    '<div class="hint">Pebble apps can only add pins while they are open, so for each sync TimeToDo ' +
    'opens on your watch for a second or two (showing the time) and closes again. If you are in another ' +
    'app at that moment, you end up back on your watchface. More frequent syncs use more battery.</div>' +
    checkbox('night', 'Pause syncing at night', settings.pauseAtNight) +
    '<div id="nightrow" class="row" style="justify-content:flex-start"><label for="nfrom">From</label>' +
    '<select id="nfrom" style="width:auto">' + options(hours, settings.nightStart) + '</select>' +
    '<label for="nto">until</label><select id="nto" style="width:auto">' + options(hours, settings.nightEnd) +
    '</select></div>' +
    '<div id="nighthint" class="hint">No background syncs during these hours, so the watch is left alone ' +
    'overnight. It catches up once when the pause ends. Opening the app still syncs right away.</div>' +
    checkbox('rem', 'Watch reminder when a timed task is due', settings.pinReminders) +
    (localPins ? '' : '<div class="hint">This phone app uses the Rebble timeline service; pins also get a ' +
      '“Complete” action.</div>') +
    '</section>' +

    '<h2>Task list in the app</h2><section>' +
    '<label for="filter">Which tasks</label>' +
    '<input id="filter" type="text" autocapitalize="off" value="' + esc(settings.filter) + '">' +
    '<div class="hint">Any Todoist filter, e.g. <code>today | overdue</code>, <code>7 days</code>, ' +
    '<code>#Work &amp; !no date</code>, <code>p1 | p2</code></div>' +
    '<label for="max">Tasks on the watch</label><select id="max">' + options(counts, settings.maxTasks) + '</select>' +
    checkbox('proj', 'Show project names', settings.showProject) +
    checkbox('c24', '24-hour time', settings.clock24) +
    '</section>' +

    '<button id="save">Save</button>' +
    '<script>' +
    'function $(i){return document.getElementById(i)}' +
    'function nightUi(){var on=$("night").checked;$("nightrow").style.display=on?"flex":"none";' +
    '$("nighthint").style.display=on?"block":"none";}' +
    '$("night").onchange=nightUi;nightUi();' +
    '$("save").onclick=function(){' +
    'var out={token:$("token").value.trim(),clearToken:!!($("clear")&&$("clear").checked),' +
    'timeline:$("tl").checked,timelineFilter:$("tlfilter").value,syncInterval:+$("iv").value,' +
    'pauseAtNight:$("night").checked,nightStart:+$("nfrom").value,nightEnd:+$("nto").value,' +
    'pinReminders:$("rem").checked,' +
    'filter:$("filter").value,maxTasks:+$("max").value,showProject:$("proj").checked,clock24:$("c24").checked};' +
    'location.href="pebblejs://close#"+encodeURIComponent(JSON.stringify(out));};' +
    '</script></body></html>';

  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

module.exports = { url: url };
