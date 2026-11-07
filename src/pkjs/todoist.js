/* Minimal Todoist API v1 client (XHR, works inside PebbleKit JS). */

var API = 'https://api.todoist.com/api/v1';

function request(method, path, token, body, cb) {
  var xhr = new XMLHttpRequest();
  var done = false;
  var timer = setTimeout(function () {
    if (!done) {
      done = true;
      try { xhr.abort(); } catch (e) {}
      cb('Todoist timed out', null, 0);
    }
  }, 20000);
  xhr.onload = function () {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    var data = null;
    try {
      data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
    } catch (e) {
      data = null;
    }
    if (xhr.status >= 200 && xhr.status < 300) {
      cb(null, data, xhr.status);
    } else if (xhr.status === 401 || xhr.status === 403) {
      cb('Token rejected, check settings', null, xhr.status);
    } else {
      cb('Todoist error ' + xhr.status, null, xhr.status);
    }
  };
  xhr.onerror = function () {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    cb('No connection', null, 0);
  };
  xhr.open(method, API + path, true);
  xhr.setRequestHeader('Authorization', 'Bearer ' + token);
  if (body) {
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify(body));
  } else {
    xhr.send();
  }
}

// Fetch up to `max` tasks matching a Todoist filter, following cursors.
function fetchFilter(token, query, max, cb) {
  var all = [];
  function page(cursor) {
    var path = '/tasks/filter?limit=' + Math.min(200, max) + '&query=' + encodeURIComponent(query) +
      (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    request('GET', path, token, null, function (err, data) {
      if (err) {
        return cb(err);
      }
      var list = (data && (data.results || data)) || [];
      all = all.concat(list);
      var next = data && data.next_cursor;
      if (next && all.length < max && list.length) {
        page(next);
      } else {
        cb(null, all.slice(0, max));
      }
    });
  }
  page(null);
}

function fetchProjects(token, cb) {
  request('GET', '/projects?limit=200', token, null, function (err, data) {
    var map = {};
    var list = (data && (data.results || data)) || [];
    for (var i = 0; i < list.length; i++) {
      map[list[i].id] = list[i].name;
    }
    cb(map); // project names are a nice-to-have; ignore errors
  });
}

function closeTask(token, id, cb) {
  request('POST', '/tasks/' + encodeURIComponent(id) + '/close', token, null, cb);
}

function updateTask(token, id, fields, cb) {
  request('POST', '/tasks/' + encodeURIComponent(id), token, fields, cb);
}

module.exports = {
  request: request,
  fetchFilter: fetchFilter,
  fetchProjects: fetchProjects,
  closeTask: closeTask,
  updateTask: updateTask
};
