/*
 * TimeToDo for Pebble — Todoist tasks in a watchapp and on the timeline.
 *
 * The phone side (src/pkjs) talks to the Todoist API directly using a
 * personal API token and inserts timeline pins locally, so this works on any
 * Pebble (Pebble, Pebble Time, Pebble Time Round, Pebble 2, Pebble Time 2,
 * Pebble 2 Duo, Pebble Round 2) and with both the Core Devices and Rebble
 * phone apps. No backend server is needed.
 *
 * Timeline pins can only be written while the app is running, so the app
 * schedules wakeups to open itself briefly, sync, and close again.
 */

#include <pebble.h>

#define MAX_TASKS 25
#define ID_LEN 24
#define TITLE_LEN 64
#define SUB_LEN 32

// Must match src/pkjs/index.js
#define STATUS_OK 0
#define STATUS_LOADING 1
#define STATUS_NEEDS_CONFIG 2
#define STATUS_ERROR 3

#define ACTION_COMPLETE 1
#define ACTION_TODAY 2
#define ACTION_TOMORROW 3
#define ACTION_WEEKEND 4
#define ACTION_NEXT_WEEK 5

#define FLAG_OVERDUE 1
#define FLAG_RECURRING 2

#define PERSIST_KEY_COUNT 1
#define PERSIST_KEY_VERSION 2
// 3 and 4 held the old daily-mode settings (v1.1); left unused on purpose.
#define PERSIST_KEY_SYNC_INTERVAL 5
#define PERSIST_KEY_SYNC_START 6
#define PERSIST_KEY_SYNC_END 7
#define PERSIST_KEY_TASK_BASE 100
#define PERSIST_VERSION 1

#define WAKEUP_TIMEOUT_MS 60000

#define HIGHLIGHT_COLOR PBL_IF_COLOR_ELSE(GColorDarkCandyAppleRed, GColorBlack)

typedef struct {
  char id[ID_LEN];
  char title[TITLE_LEN];
  char sub[SUB_LEN];
  uint8_t prio;   // Todoist API priority: 4 = p1 (urgent) … 1 = p4 (none)
  uint8_t flags;
} Task;

static Task s_tasks[MAX_TASKS];
static int s_count = 0;
static int s_expected = 0;
static int s_status = STATUS_LOADING;
static char s_status_text[96];
static bool s_dirty = false;

static Window *s_main_window;
static StatusBarLayer *s_status_bar;
static MenuLayer *s_menu_layer;
static TextLayer *s_overlay_layer;
static TextLayer *s_toast_layer;
static AppTimer *s_toast_timer;

static Window *s_action_window;
static MenuLayer *s_action_menu;
static int s_action_task = -1;
static int s_action_ids[5];
static int s_action_count = 0;

static GFont s_title_font;
static GFont s_sub_font;
static bool s_big_screen;

// Background (wakeup) sync and timeline-action launches
static bool s_wakeup_mode = false;
static Window *s_sync_window;
static TextLayer *s_sync_text;
static TextLayer *s_sync_time;
static AppTimer *s_exit_timer;
static int32_t s_pending_launch_code = -1;
static bool s_hello_sent = false;
static AppTimer *s_hello_timer;
static bool s_sync_error_shown = false;

static void main_window_push(void);
static void send_simple(uint32_t key, int value, const char *task_id);

// ---------------------------------------------------------------------------
// Persistence: keep the last list so the app opens instantly and works offline

static void load_cache(void) {
  if (persist_read_int(PERSIST_KEY_VERSION) != PERSIST_VERSION) {
    return;
  }
  int count = persist_read_int(PERSIST_KEY_COUNT);
  if (count < 0 || count > MAX_TASKS) {
    return;
  }
  for (int i = 0; i < count; i++) {
    if (persist_read_data(PERSIST_KEY_TASK_BASE + i, &s_tasks[i], sizeof(Task)) != (int)sizeof(Task)) {
      count = i;
      break;
    }
  }
  s_count = count;
  if (count > 0) {
    s_status = STATUS_OK;
  }
}

static void save_cache(void) {
  if (!s_dirty) {
    return;
  }
  persist_write_int(PERSIST_KEY_VERSION, PERSIST_VERSION);
  persist_write_int(PERSIST_KEY_COUNT, s_count);
  for (int i = 0; i < s_count; i++) {
    persist_write_data(PERSIST_KEY_TASK_BASE + i, &s_tasks[i], sizeof(Task));
  }
  for (int i = s_count; i < MAX_TASKS; i++) {
    if (persist_exists(PERSIST_KEY_TASK_BASE + i)) {
      persist_delete(PERSIST_KEY_TASK_BASE + i);
    }
  }
  s_dirty = false;
}

// ---------------------------------------------------------------------------
// UI helpers

static void empty_click_config(void *context);
static bool s_empty_mode = false;

// When the list is empty the MenuLayer has no rows to select, so swap in our
// own click config (SELECT = refresh). Swap back once tasks arrive.
static void set_empty_mode(bool empty) {
  if (empty == s_empty_mode || !s_menu_layer) {
    return;
  }
  s_empty_mode = empty;
  layer_set_hidden(menu_layer_get_layer(s_menu_layer), empty);
  if (empty) {
    window_set_click_config_provider(s_main_window, empty_click_config);
  } else {
    menu_layer_set_click_config_onto_window(s_menu_layer, s_main_window);
  }
}

static void update_overlay(void) {
  if (!s_overlay_layer) {
    return;
  }
  bool show = (s_count == 0);
  set_empty_mode(show);
  if (show) {
    const char *text;
    switch (s_status) {
      case STATUS_LOADING:
        text = "Loading tasks…";
        break;
      case STATUS_NEEDS_CONFIG:
        text = "Open TimeToDo settings in the Pebble app and add your Todoist API token";
        break;
      case STATUS_ERROR:
        text = s_status_text[0] ? s_status_text : "Couldn't load tasks";
        break;
      default:
        text = "All done!\nNothing due.";
        break;
    }
    text_layer_set_text(s_overlay_layer, text);
  }
  layer_set_hidden(text_layer_get_layer(s_overlay_layer), !show);
}

static void toast_hide(void *context) {
  s_toast_timer = NULL;
  layer_set_hidden(text_layer_get_layer(s_toast_layer), true);
}

static void toast_show(const char *text) {
  if (!s_toast_layer) {
    return;
  }
  static char s_toast_text[48];
  strncpy(s_toast_text, text, sizeof(s_toast_text) - 1);
  s_toast_text[sizeof(s_toast_text) - 1] = '\0';
  text_layer_set_text(s_toast_layer, s_toast_text);
  layer_set_hidden(text_layer_get_layer(s_toast_layer), false);
  if (s_toast_timer) {
    app_timer_reschedule(s_toast_timer, 2000);
  } else {
    s_toast_timer = app_timer_register(2000, toast_hide, NULL);
  }
}

static void reload_list(void) {
  if (s_menu_layer) {
    menu_layer_reload_data(s_menu_layer);
  }
  update_overlay();
}

static void remove_task(int index) {
  if (index < 0 || index >= s_count) {
    return;
  }
  for (int i = index; i < s_count - 1; i++) {
    s_tasks[i] = s_tasks[i + 1];
  }
  s_count--;
  s_dirty = true;
  if (s_status == STATUS_LOADING) {
    s_status = STATUS_OK;
  }
  reload_list();
}

// ---------------------------------------------------------------------------
// Scheduled background sync
//
// Settings (from the phone): interval in minutes (0 = off, 1440 = once a
// day), and an active window [start, end) in hours. Outside the window the
// watch is left alone until the window opens again. start == end means
// "all day".

static bool in_window(time_t ts, int start, int end) {
  if (start == end) {
    return true;
  }
  int h = localtime(&ts)->tm_hour;
  return start < end ? (h >= start && h < end) : (h >= start || h < end);
}

// First time at start:01 strictly after `after`.
static time_t next_window_start(time_t after, int start) {
  struct tm t = *localtime(&after);
  t.tm_hour = start;
  t.tm_min = 1;
  t.tm_sec = 0;
  time_t ts = mktime(&t);
  while (ts <= after) {
    ts += SECONDS_PER_DAY;
  }
  return ts;
}

static void schedule_wakeup(void) {
  wakeup_cancel_all();
  int interval = persist_exists(PERSIST_KEY_SYNC_INTERVAL) ? persist_read_int(PERSIST_KEY_SYNC_INTERVAL) : 0;
  if (interval <= 0) {
    return;
  }
  if (interval < 5) {
    interval = 5;
  }
  int start = persist_read_int(PERSIST_KEY_SYNC_START);
  int end = persist_read_int(PERSIST_KEY_SYNC_END);
  if (start < 0 || start > 23) start = 7;
  if (end < 0 || end > 23) end = 23;

  time_t now = time(NULL);
  time_t best;
  if (interval >= MINUTES_PER_DAY) {
    best = next_window_start(now + 60, start);
  } else {
    best = now + interval * SECONDS_PER_MINUTE;
    if (!in_window(best, start, end)) {
      best = next_window_start(best, start);
    }
  }
  // Wakeups from different apps must be at least a minute apart.
  for (int attempt = 0; attempt < 10; attempt++) {
    WakeupId id = wakeup_schedule(best + attempt * 60, 0, false);
    if (id >= 0) {
      APP_LOG(APP_LOG_LEVEL_INFO, "Next timeline sync at %d", (int)(best + attempt * 60));
      return;
    }
    if (id != E_RANGE) {
      APP_LOG(APP_LOG_LEVEL_WARNING, "wakeup_schedule failed: %d", (int)id);
      return;
    }
  }
}

static void exit_app(void *context) {
  s_exit_timer = NULL;
  window_stack_pop_all(false);
}

static void exit_soon(uint32_t ms) {
  if (s_exit_timer) {
    app_timer_reschedule(s_exit_timer, ms);
  } else {
    s_exit_timer = app_timer_register(ms, exit_app, NULL);
  }
}

static void sync_set_text(const char *text) {
  if (s_sync_text) {
    text_layer_set_text(s_sync_text, text);
  }
}

// Select on the sync screen opens the full app instead of closing.
static void sync_select(ClickRecognizerRef recognizer, void *context) {
  s_wakeup_mode = false;
  if (s_exit_timer) {
    app_timer_cancel(s_exit_timer);
    s_exit_timer = NULL;
  }
  main_window_push();
  window_stack_remove(s_sync_window, false);
  // The phone was told this was a background sync; ask for the full list.
  send_simple(MESSAGE_KEY_Refresh, 1, NULL);
}

static void sync_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, sync_select);
}

// The sync screen doubles as a plain watchface (big clock), so a glance at
// the watch during the few seconds it's up still tells the time.
static void sync_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  bool big = bounds.size.h >= 220;

  static char s_time_buf[8];
  clock_copy_time_string(s_time_buf, sizeof(s_time_buf));
  // Drop the AM/PM suffix in 12h mode; it doesn't fit the big font.
  char *space = strchr(s_time_buf, ' ');
  if (space) {
    *space = '\0';
  }
  GFont time_font = fonts_get_system_font(FONT_KEY_LECO_42_NUMBERS);
  int16_t time_h = 50;
  int16_t time_y = bounds.size.h / 2 - time_h + 4;
  s_sync_time = text_layer_create(GRect(0, time_y, bounds.size.w, time_h));
  text_layer_set_font(s_sync_time, time_font);
  text_layer_set_text_alignment(s_sync_time, GTextAlignmentCenter);
  text_layer_set_background_color(s_sync_time, GColorClear);
  text_layer_set_text_color(s_sync_time, GColorWhite);
  text_layer_set_text(s_sync_time, s_time_buf);
  layer_add_child(root, text_layer_get_layer(s_sync_time));

  GFont font = fonts_get_system_font(big ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14);
  s_sync_text = text_layer_create(GRect(PBL_IF_ROUND_ELSE(20, 4), time_y + time_h + 6,
                                        bounds.size.w - PBL_IF_ROUND_ELSE(40, 8), 24));
  text_layer_set_font(s_sync_text, font);
  text_layer_set_text_alignment(s_sync_text, GTextAlignmentCenter);
  text_layer_set_background_color(s_sync_text, GColorClear);
  text_layer_set_text_color(s_sync_text, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  text_layer_set_text(s_sync_text, "Syncing Todoist…");
  layer_add_child(root, text_layer_get_layer(s_sync_text));
}

static void sync_window_unload(Window *window) {
  text_layer_destroy(s_sync_text);
  s_sync_text = NULL;
  text_layer_destroy(s_sync_time);
  s_sync_time = NULL;
}

static void sync_window_push(void) {
  s_sync_window = window_create();
  window_set_background_color(s_sync_window, GColorBlack);
  window_set_click_config_provider(s_sync_window, sync_click_config);
  window_set_window_handlers(s_sync_window, (WindowHandlers){
    .load = sync_window_load,
    .unload = sync_window_unload,
  });
  window_stack_push(s_sync_window, false);
}

// ---------------------------------------------------------------------------
// AppMessage

static void send_simple(uint32_t key, int value, const char *task_id) {
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    toast_show("Phone busy, try again");
    return;
  }
  dict_write_int32(iter, key, value);
  if (task_id) {
    dict_write_cstring(iter, MESSAGE_KEY_TaskId, task_id);
  }
  if (app_message_outbox_send() != APP_MSG_OK) {
    toast_show("Phone not connected");
  }
}

static void request_refresh(void) {
  send_simple(MESSAGE_KEY_Refresh, 1, NULL);
  if (s_count > 0) {
    toast_show("Refreshing…");
  } else {
    s_status = STATUS_LOADING;
    update_overlay();
  }
}

static void copy_string(char *dest, size_t size, Tuple *t) {
  if (t && t->type == TUPLE_CSTRING) {
    strncpy(dest, t->value->cstring, size - 1);
    dest[size - 1] = '\0';
  } else {
    dest[0] = '\0';
  }
}

// First message to the phone once PebbleKit JS is up: says whether this is a
// quick background sync (so the phone skips the task list) and forwards a
// "Complete" picked on a timeline pin (Rebble app).
static void send_hello(void *context) {
  s_hello_timer = NULL;
  if (s_hello_sent) {
    return;
  }
  DictionaryIterator *iter;
  if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
    s_hello_timer = app_timer_register(300, send_hello, NULL);
    return;
  }
  dict_write_int32(iter, MESSAGE_KEY_Hello, s_wakeup_mode ? 1 : 0);
  if (s_pending_launch_code >= 0) {
    dict_write_int32(iter, MESSAGE_KEY_Action, ACTION_COMPLETE);
    dict_write_int32(iter, MESSAGE_KEY_LaunchCode, s_pending_launch_code);
  }
  if (app_message_outbox_send() == APP_MSG_OK) {
    s_hello_sent = true;
    if (s_pending_launch_code >= 0) {
      s_pending_launch_code = -1;
      toast_show("Completing…");
    }
  } else {
    s_hello_timer = app_timer_register(300, send_hello, NULL);
  }
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason, void *context) {
  if (iter && dict_find(iter, MESSAGE_KEY_Hello)) {
    s_hello_sent = false;
    if (!s_hello_timer) {
      s_hello_timer = app_timer_register(500, send_hello, NULL);
    }
  }
}

static void inbox_received(DictionaryIterator *iter, void *context) {
  Tuple *t;

  // Any message means PebbleKit JS is running.
  if (!s_hello_sent && !s_hello_timer) {
    send_hello(NULL);
  }

  if ((t = dict_find(iter, MESSAGE_KEY_SyncInterval))) {
    int interval = (int)t->value->int32;
    Tuple *s = dict_find(iter, MESSAGE_KEY_SyncStart);
    Tuple *e = dict_find(iter, MESSAGE_KEY_SyncEnd);
    int start = s ? (int)s->value->int32 : 7;
    int end = e ? (int)e->value->int32 : 23;
    bool changed = !persist_exists(PERSIST_KEY_SYNC_INTERVAL) ||
                   persist_read_int(PERSIST_KEY_SYNC_INTERVAL) != interval ||
                   persist_read_int(PERSIST_KEY_SYNC_START) != start ||
                   persist_read_int(PERSIST_KEY_SYNC_END) != end;
    if (changed) {
      persist_write_int(PERSIST_KEY_SYNC_INTERVAL, interval);
      persist_write_int(PERSIST_KEY_SYNC_START, start);
      persist_write_int(PERSIST_KEY_SYNC_END, end);
      // During a background sync the next wakeup was already queued in init
      // from the old settings; requeue from the new ones.
      schedule_wakeup();
    }
  }

  if ((t = dict_find(iter, MESSAGE_KEY_SyncDone))) {
    bool ok = t->value->int32 >= 0;
    if (s_wakeup_mode) {
      sync_set_text(ok ? "Timeline updated" : "Sync failed");
      exit_soon(ok ? 300 : 1500);
    } else if (!ok && !s_sync_error_shown) {
      s_sync_error_shown = true;
      static char s_sync_err[64];
      copy_string(s_sync_err, sizeof(s_sync_err), dict_find(iter, MESSAGE_KEY_StatusText));
      toast_show(s_sync_err[0] ? s_sync_err : "Timeline sync failed");
    }
  }

  if ((t = dict_find(iter, MESSAGE_KEY_Status))) {
    s_status = (int)t->value->int32;
    copy_string(s_status_text, sizeof(s_status_text), dict_find(iter, MESSAGE_KEY_StatusText));
    if (s_status == STATUS_NEEDS_CONFIG) {
      s_count = 0;
      s_dirty = true;
      reload_list();
    } else if (s_status == STATUS_ERROR && s_count > 0) {
      toast_show(s_status_text[0] ? s_status_text : "Sync failed");
    }
    update_overlay();
  }

  if ((t = dict_find(iter, MESSAGE_KEY_TaskCount))) {
    s_expected = (int)t->value->int32;
    if (s_expected > MAX_TASKS) {
      s_expected = MAX_TASKS;
    }
    if (s_expected <= 0) {
      s_expected = 0;
      s_count = 0;
      s_status = STATUS_OK;
      s_dirty = true;
      reload_list();
    }
  }

  if ((t = dict_find(iter, MESSAGE_KEY_TaskIndex))) {
    int i = (int)t->value->int32;
    if (i >= 0 && i < MAX_TASKS && i < s_expected) {
      Task *task = &s_tasks[i];
      copy_string(task->id, sizeof(task->id), dict_find(iter, MESSAGE_KEY_TaskId));
      copy_string(task->title, sizeof(task->title), dict_find(iter, MESSAGE_KEY_TaskTitle));
      copy_string(task->sub, sizeof(task->sub), dict_find(iter, MESSAGE_KEY_TaskSub));
      Tuple *p = dict_find(iter, MESSAGE_KEY_TaskPrio);
      task->prio = p ? (uint8_t)p->value->int32 : 1;
      Tuple *f = dict_find(iter, MESSAGE_KEY_TaskFlags);
      task->flags = f ? (uint8_t)f->value->int32 : 0;
      // Swap the list in once the last task arrives, so it never shows half-updated.
      if (i == s_expected - 1) {
        s_count = s_expected;
        s_status = STATUS_OK;
        s_dirty = true;
        reload_list();
      }
    }
  }

  if ((t = dict_find(iter, MESSAGE_KEY_ActionResult))) {
    if (t->value->int32) {
      vibes_short_pulse();
      toast_show("Done");
    } else {
      vibes_double_pulse();
      copy_string(s_status_text, sizeof(s_status_text), dict_find(iter, MESSAGE_KEY_StatusText));
      toast_show(s_status_text[0] ? s_status_text : "Failed");
    }
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  APP_LOG(APP_LOG_LEVEL_WARNING, "Inbox dropped: %d", (int)reason);
}

// ---------------------------------------------------------------------------
// Drawing

static GColor prio_color(uint8_t prio) {
#ifdef PBL_COLOR
  switch (prio) {
    case 4: return GColorRed;
    case 3: return GColorOrange;
    case 2: return GColorBlueMoon;
    default: return GColorClear;
  }
#else
  return prio > 1 ? GColorBlack : GColorClear;
#endif
}

static int16_t line_height(GFont font) {
  return graphics_text_layout_get_content_size("Ag", font, GRect(0, 0, 200, 100),
                                               GTextOverflowModeTrailingEllipsis,
                                               GTextAlignmentLeft).h;
}

static int16_t text_width_inset(int16_t width, bool focused) {
  // Leave room for the priority bar on rectangular screens, and keep text
  // inside the circle on round ones.
  return PBL_IF_ROUND_ELSE(width - (focused ? width / 5 : width / 3), width - 14);
}

static int16_t task_row_height(int index, int16_t width, bool focused) {
  if (index >= s_count) {
    return 44;
  }
  Task *task = &s_tasks[index];
  int16_t title_line = line_height(s_title_font);
  int16_t max_title = PBL_IF_ROUND_ELSE(focused ? title_line * 2 : title_line, title_line * 2);
  GSize size = graphics_text_layout_get_content_size(
      task->title, s_title_font, GRect(0, 0, text_width_inset(width, focused), max_title),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);
  int16_t h = size.h > max_title ? max_title : size.h;
  if (h < title_line) {
    h = title_line;
  }
  if (task->sub[0]) {
    h += line_height(s_sub_font);
  }
  return h + (s_big_screen ? 14 : 10);
}

static uint16_t main_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  return s_count;
}

static int16_t main_cell_height(MenuLayer *menu, MenuIndex *index, void *ctx) {
  Layer *layer = menu_layer_get_layer(menu);
  int16_t width = layer_get_bounds(layer).size.w;
  bool focused = PBL_IF_ROUND_ELSE(menu_layer_is_index_selected(menu, index), true);
  return task_row_height(index->row, width, focused);
}

static void main_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *index, void *data) {
  if (index->row >= s_count) {
    return;
  }
  Task *task = &s_tasks[index->row];
  GRect bounds = layer_get_bounds(cell_layer);
  bool highlighted = menu_cell_layer_is_highlighted(cell_layer);
  GColor fg = highlighted ? GColorWhite : GColorBlack;
  GTextAlignment align = PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft);
  int16_t pad = s_big_screen ? 7 : 5;

  int16_t text_w = text_width_inset(bounds.size.w, PBL_IF_ROUND_ELSE(highlighted, true));
  int16_t text_x = PBL_IF_ROUND_ELSE((bounds.size.w - text_w) / 2, 10);

  // Priority marker: a bar on the left (rect) or a dot above the title (round)
  GColor marker = prio_color(task->prio);
  if (!gcolor_equal(marker, GColorClear)) {
    if (highlighted) {
      marker = GColorWhite;
    }
    graphics_context_set_fill_color(ctx, marker);
#ifdef PBL_ROUND
    if (highlighted) {
      graphics_fill_circle(ctx, GPoint(bounds.size.w / 2, pad - 1), 2);
    }
#else
    int16_t bar_w = PBL_IF_COLOR_ELSE(4, task->prio == 4 ? 4 : (task->prio == 3 ? 3 : 1));
    graphics_fill_rect(ctx, GRect(2, pad, bar_w, bounds.size.h - pad * 2), 1, GCornerNone);
#endif
  }

  int16_t sub_h = task->sub[0] ? line_height(s_sub_font) : 0;
  int16_t title_h = bounds.size.h - sub_h - pad * 2;

  graphics_context_set_text_color(ctx, fg);
  graphics_draw_text(ctx, task->title, s_title_font,
                     GRect(text_x, pad - 3, text_w, title_h + 3),
                     GTextOverflowModeTrailingEllipsis, align, NULL);

  if (sub_h) {
    GColor sub_color = fg;
#ifdef PBL_COLOR
    if (!highlighted) {
      sub_color = (task->flags & FLAG_OVERDUE) ? GColorRed : GColorDarkGray;
    }
#endif
    graphics_context_set_text_color(ctx, sub_color);
    graphics_draw_text(ctx, task->sub, s_sub_font,
                       GRect(text_x, bounds.size.h - pad - sub_h - 2, text_w, sub_h + 2),
                       GTextOverflowModeTrailingEllipsis, align, NULL);
  }
}

// ---------------------------------------------------------------------------
// Action window

static const char *action_label(int action) {
  switch (action) {
    case ACTION_COMPLETE: return "Complete";
    case ACTION_TODAY: return "Due today";
    case ACTION_TOMORROW: return "Due tomorrow";
    case ACTION_WEEKEND: return "This weekend";
    case ACTION_NEXT_WEEK: return "Next week";
    default: return "";
  }
}

static uint16_t action_num_rows(MenuLayer *menu, uint16_t section, void *ctx) {
  return s_action_count;
}

static int16_t action_header_height(MenuLayer *menu, uint16_t section, void *ctx) {
  if (s_action_task < 0 || s_action_task >= s_count) {
    return 0;
  }
  int16_t width = layer_get_bounds(menu_layer_get_layer(menu)).size.w;
  int16_t text_w = PBL_IF_ROUND_ELSE(width - width / 4, width - 12);
  GSize size = graphics_text_layout_get_content_size(
      s_tasks[s_action_task].title, s_title_font, GRect(0, 0, text_w, line_height(s_title_font) * 3),
      GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft);
  return size.h + (s_big_screen ? 16 : 12);
}

static void action_draw_header(GContext *ctx, const Layer *cell_layer, uint16_t section, void *data) {
  if (s_action_task < 0 || s_action_task >= s_count) {
    return;
  }
  GRect bounds = layer_get_bounds(cell_layer);
  int16_t text_w = PBL_IF_ROUND_ELSE(bounds.size.w - bounds.size.w / 4, bounds.size.w - 12);
  graphics_context_set_text_color(ctx, GColorBlack);
  graphics_draw_text(ctx, s_tasks[s_action_task].title, s_title_font,
                     GRect((bounds.size.w - text_w) / 2, 2, text_w, bounds.size.h - 4),
                     GTextOverflowModeTrailingEllipsis,
                     PBL_IF_ROUND_ELSE(GTextAlignmentCenter, GTextAlignmentLeft), NULL);
}

static int16_t action_cell_height(MenuLayer *menu, MenuIndex *index, void *ctx) {
  return line_height(s_title_font) + (s_big_screen ? 18 : 14);
}

static void action_draw_row(GContext *ctx, const Layer *cell_layer, MenuIndex *index, void *data) {
  menu_cell_basic_draw(ctx, cell_layer, action_label(s_action_ids[index->row]), NULL, NULL);
}

static void action_select(MenuLayer *menu, MenuIndex *index, void *ctx) {
  if (s_action_task < 0 || s_action_task >= s_count) {
    window_stack_remove(s_action_window, true);
    return;
  }
  int action = s_action_ids[index->row];
  int task_index = s_action_task;
  send_simple(MESSAGE_KEY_Action, action, s_tasks[task_index].id);
  window_stack_remove(s_action_window, true);
  if (action == ACTION_COMPLETE) {
    // Optimistic: the phone resends the real list right after.
    remove_task(task_index);
    toast_show("Completing…");
  } else {
    toast_show("Rescheduling…");
  }
}

static void action_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);
  s_action_menu = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_action_menu, NULL, (MenuLayerCallbacks){
    .get_num_rows = action_num_rows,
    .get_header_height = action_header_height,
    .draw_header = action_draw_header,
    .get_cell_height = action_cell_height,
    .draw_row = action_draw_row,
    .select_click = action_select,
  });
  menu_layer_set_highlight_colors(s_action_menu, HIGHLIGHT_COLOR, GColorWhite);
  menu_layer_set_click_config_onto_window(s_action_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_action_menu));
}

static void action_window_unload(Window *window) {
  menu_layer_destroy(s_action_menu);
  s_action_menu = NULL;
}

static void show_actions(int task_index) {
  if (task_index < 0 || task_index >= s_count) {
    return;
  }
  s_action_task = task_index;
  s_action_count = 0;
  s_action_ids[s_action_count++] = ACTION_COMPLETE;
  // Moving a recurring task to a fixed date would break its recurrence,
  // so only offer "Complete" (which advances it to the next occurrence).
  if (!(s_tasks[task_index].flags & FLAG_RECURRING)) {
    s_action_ids[s_action_count++] = ACTION_TODAY;
    s_action_ids[s_action_count++] = ACTION_TOMORROW;
    s_action_ids[s_action_count++] = ACTION_WEEKEND;
    s_action_ids[s_action_count++] = ACTION_NEXT_WEEK;
  }
  if (!s_action_window) {
    s_action_window = window_create();
    window_set_background_color(s_action_window, GColorWhite);
    window_set_window_handlers(s_action_window, (WindowHandlers){
      .load = action_window_load,
      .unload = action_window_unload,
    });
  }
  window_stack_push(s_action_window, true);
}

// ---------------------------------------------------------------------------
// Main window

static void main_select(MenuLayer *menu, MenuIndex *index, void *ctx) {
  show_actions(index->row);
}

static void main_select_long(MenuLayer *menu, MenuIndex *index, void *ctx) {
  request_refresh();
}

static void empty_select(ClickRecognizerRef recognizer, void *context) {
  request_refresh();
}

static void empty_click_config(void *context) {
  window_single_click_subscribe(BUTTON_ID_SELECT, empty_select);
}

static void main_window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect bounds = layer_get_bounds(root);

  s_big_screen = bounds.size.h >= 220;
  s_title_font = fonts_get_system_font(s_big_screen ? FONT_KEY_GOTHIC_24_BOLD : FONT_KEY_GOTHIC_18_BOLD);
  s_sub_font = fonts_get_system_font(s_big_screen ? FONT_KEY_GOTHIC_18 : FONT_KEY_GOTHIC_14);

  s_status_bar = status_bar_layer_create();
  status_bar_layer_set_colors(s_status_bar, GColorWhite, GColorBlack);
  status_bar_layer_set_separator_mode(s_status_bar, StatusBarLayerSeparatorModeNone);
  layer_add_child(root, status_bar_layer_get_layer(s_status_bar));

  GRect menu_bounds = GRect(0, STATUS_BAR_LAYER_HEIGHT, bounds.size.w,
                            bounds.size.h - STATUS_BAR_LAYER_HEIGHT);
  s_menu_layer = menu_layer_create(menu_bounds);
  menu_layer_set_callbacks(s_menu_layer, NULL, (MenuLayerCallbacks){
    .get_num_rows = main_num_rows,
    .get_cell_height = main_cell_height,
    .draw_row = main_draw_row,
    .select_click = main_select,
    .select_long_click = main_select_long,
  });
  menu_layer_set_highlight_colors(s_menu_layer, HIGHLIGHT_COLOR, GColorWhite);
  menu_layer_set_click_config_onto_window(s_menu_layer, window);
  layer_add_child(root, menu_layer_get_layer(s_menu_layer));

  GRect overlay = grect_inset(menu_bounds, GEdgeInsets(bounds.size.h / 6, PBL_IF_ROUND_ELSE(24, 10)));
  s_overlay_layer = text_layer_create(overlay);
  text_layer_set_font(s_overlay_layer, s_title_font);
  text_layer_set_text_alignment(s_overlay_layer, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_overlay_layer, GTextOverflowModeWordWrap);
  text_layer_set_background_color(s_overlay_layer, GColorClear);
  layer_add_child(root, text_layer_get_layer(s_overlay_layer));

  int16_t toast_h = line_height(s_sub_font) + 10;
  s_toast_layer = text_layer_create(
      GRect(0, bounds.size.h - toast_h - PBL_IF_ROUND_ELSE(16, 0), bounds.size.w, toast_h));
  text_layer_set_font(s_toast_layer, s_sub_font);
  text_layer_set_text_alignment(s_toast_layer, GTextAlignmentCenter);
  text_layer_set_background_color(s_toast_layer, GColorBlack);
  text_layer_set_text_color(s_toast_layer, GColorWhite);
  layer_set_hidden(text_layer_get_layer(s_toast_layer), true);
  layer_add_child(root, text_layer_get_layer(s_toast_layer));

  update_overlay();
}

static void main_window_unload(Window *window) {
  if (s_toast_timer) {
    app_timer_cancel(s_toast_timer);
    s_toast_timer = NULL;
  }
  text_layer_destroy(s_toast_layer);
  s_toast_layer = NULL;
  text_layer_destroy(s_overlay_layer);
  s_overlay_layer = NULL;
  menu_layer_destroy(s_menu_layer);
  s_menu_layer = NULL;
  s_empty_mode = false;
  status_bar_layer_destroy(s_status_bar);
}

static void main_window_push(void) {
  if (!s_main_window) {
    s_main_window = window_create();
    window_set_background_color(s_main_window, GColorWhite);
    window_set_window_handlers(s_main_window, (WindowHandlers){
      .load = main_window_load,
      .unload = main_window_unload,
    });
  }
  window_stack_push(s_main_window, true);
}

static void wakeup_handler(WakeupId id, int32_t cookie) {
  // A scheduled sync fired while the app was already open: just refresh.
  schedule_wakeup();
  send_simple(MESSAGE_KEY_Refresh, 1, NULL);
}

static void init(void) {
  load_cache();

  AppLaunchReason reason = launch_reason();
  if (reason == APP_LAUNCH_WAKEUP) {
    s_wakeup_mode = true;
  } else if (reason == APP_LAUNCH_TIMELINE_ACTION) {
    s_pending_launch_code = (int32_t)launch_get_args();
  }

  wakeup_service_subscribe(wakeup_handler);
  schedule_wakeup();   // always keep the next sync queued

  if (s_wakeup_mode) {
    sync_window_push();
    if (!connection_service_peek_pebble_app_connection()) {
      // Nothing to sync without the phone: get out of the way immediately.
      sync_set_text("Phone not connected");
      exit_soon(600);
    } else {
      exit_soon(WAKEUP_TIMEOUT_MS);
    }
  } else {
    main_window_push();
  }

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(512, 128);
}

static void deinit(void) {
  save_cache();
  if (s_action_window) {
    window_destroy(s_action_window);
  }
  if (s_main_window) {
    window_destroy(s_main_window);
  }
  if (s_sync_window) {
    window_destroy(s_sync_window);
  }
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
