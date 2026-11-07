# TimeToDo for Pebble

Your Todoist tasks **on the Pebble timeline**, plus a watchapp to browse,
complete and reschedule them from the wrist.

Unlike the original TimeToDo (which pushed pins from a server through the old
timeline web API), this version does everything on your phone:

- **Works with the Core Devices Pebble app.** That app no longer accepts pins
  from servers and gives sideloaded apps no timeline token, so it uses the new
  local `Pebble.insertTimelinePin()` API instead.
- **Also works with the Rebble app,** using the Rebble timeline web API
  directly from the phone (there pins also get a "Complete" action).
- **No backend.** Your token stays on your phone and is only sent to
  `api.todoist.com`.
- **Every Pebble:** aplite (Pebble, Pebble Steel), basalt (Pebble Time,
  Time Steel), chalk (Time Round), diorite (Pebble 2), emery (Pebble Time 2),
  flint (Pebble 2 Duo) and gabbro (Pebble Round 2).

## Timeline

| Todoist task | On the timeline |
| --- | --- |
| Has a time | Pin at that time, with its Todoist duration if set |
| Date only | "All day" pin on that day |
| Overdue | "All day" pin on today, subtitle "Overdue since …" |
| Completed / deleted / out of range | Pin removed on the next sync |

Pins show the task, project, description, priority, labels and the due /
repeat string. Optionally a watch reminder fires when a timed task is due.

Which tasks: any Todoist filter, default `overdue | 7 days` (max 60 pins).

### When it syncs

Pebble apps can only add pins **while they are running**, so:

- it syncs every time you open TimeToDo (and every 5 minutes while open);
- in the background it **wakes itself** with the Pebble wakeup API, by default
  **every 10 minutes** (choose 5 / 10 / 15 / 30 min, hourly, every 4 hours,
  once a day, or never);
- **Pause syncing at night** (on by default, 23:00 until 07:00, both
  adjustable): no background syncs during those hours, then one catch-up sync
  when the pause ends. Turn it off to sync around the clock.
- A background sync only updates the timeline: one Todoist request (project
  names are cached), only changed pins re-sent, no task list transfer. The
  watch shows a plain clock with "Syncing Todoist…" for a second or two and
  returns to the watchface. Press Select on it to open the app instead.
- Trade-offs: if you're in another app when a sync fires, you end up back on
  the watchface afterwards (the firmware always launches the app for a
  wakeup), and frequent syncs cost some battery on watch and phone.

Note: on the Core app, every local pin gets a single "Remove" action (the app
ignores custom pin actions). Removing a pin does not complete the task.

## Setup

1. Install the `.pbw` (open it with the Pebble/Core app on your phone, or
   `pebble install --phone <ip> build/timetodo-watch.pbw`).
2. Open TimeToDo once on the watch, then open its settings on the phone and
   paste your Todoist API token (Todoist → Settings → Integrations →
   Developer → API token).
3. Adjust the timeline filter, sync schedule, reminders, and the in-app list.

## In the app

| Button | Action |
| --- | --- |
| Up / Down | Scroll tasks |
| Select | Complete, Due today, Due tomorrow, This weekend, Next week |
| Long-press Select | Refresh (and sync the timeline) |

Priority shows as a coloured bar (red p1, orange p2, blue p3), or bar
thickness on black-and-white watches. Recurring tasks only offer Complete.

## Building

```sh
pebble build          # produces build/timetodo-watch.pbw
pebble install --emulator basalt
```

## Credits

Based on [TimeToDo](https://github.com/blockarchitech/timetodo) by blockarchitech
(Apache License 2.0), rewritten to run entirely on the phone and watch.
Not affiliated with Doist / Todoist.

## Layout

```
src/c/main.c          watch UI, task cache, wakeup scheduling, sync screen
src/pkjs/index.js     settings, refresh flow, actions, AppMessage queue
src/pkjs/timeline.js  pin building + diff sync (local pins or Rebble web API)
src/pkjs/todoist.js   Todoist API v1 client
src/pkjs/util.js      text/date helpers
src/pkjs/config.js    settings page (data: URI, no external hosting)
```
