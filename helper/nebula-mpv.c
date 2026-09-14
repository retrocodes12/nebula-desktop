/* nebula-mpv — libmpv in a process of its own, for Nebula's full-format player (desktop).
 *
 * The page's process cannot host libmpv on Linux: Electron's own FFmpeg (libffmpeg.so, unversioned symbols) and its
 * libvulkan sit first in that process's symbol scope, and libmpv's calls land in them — an ABI mismatch that aborts
 * (measured 09-15; a second link-map namespace segfaulted inside Electron too). Here libmpv runs the way the mpv player
 * runs it: a plain process with the system's own libraries. Every frame is drawn by libmpv's software renderer into a
 * frame buffer that frames.c serves to the page over loopback HTTP (the page stays sandboxed), and mpv's own JSON IPC
 * server (input-ipc-server) carries commands, properties and events for the main process. The helper exits when mpv
 * quits, when its parent goes, or when its stdin (a pipe from the parent) closes.
 *
 *   nebula-mpv <ipc> <max-w> <max-h> <parent-pid> <token> <origin> <libmpv>[|<libmpv>...] [option=value ...]
 *       prints "READY <port>" once mpv is up and the frame server listens (GET /<token>/f… from <origin>, see frames.c)
 *   nebula-mpv --probe <libmpv>
 *       "OK <libmpv>" (exit 0) when it loads, starts and can draw in software; else "ERROR <why>" and exit 4 (will not
 *       load), 6/7 (mpv will not be made / start) or 8 (too old to draw here)
 * On Windows the arguments arrive as UTF-16 (wmain, -municode): an install folder under any user name loads.
 */
#ifndef _WIN32
#define _GNU_SOURCE
#endif
#include "nebula-mpv.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <mmsystem.h>                                  /* timeBeginPeriod: link -lwinmm */
#else
#include <dlfcn.h>
#include <errno.h>
#include <libgen.h>
#include <pthread.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#endif

typedef struct { int type; void *data; } mpv_render_param;
typedef struct { int event_id; int error; uint64_t reply_userdata; void *data; } mpv_event;
enum { EV_SHUTDOWN = 1, EV_START_FILE = 6, RP_API_TYPE = 1, RP_NEXT_FRAME_INFO = 11, RP_BLOCK = 12, RP_SKIP = 13, RP_SW_SIZE = 17,
  RP_SW_FORMAT = 18, RP_SW_STRIDE = 19, RP_SW_POINTER = 20, UPDATE_FRAME = 1 };
typedef struct { uint64_t flags; int64_t target_time; } frame_info_t;

static void *(*p_create)(void);
static int (*p_initialize)(void *);
static int (*p_set_option_string)(void *, const char *, const char *);
static mpv_event *(*p_wait_event)(void *, double);
static void (*p_terminate_destroy)(void *);
static int (*p_rcreate)(void **, void *, mpv_render_param *);
static void (*p_rset_update_callback)(void *, void (*)(void *), void *);
static uint64_t (*p_rupdate)(void *);
static int (*p_render)(void *, mpv_render_param *);
static void (*p_report_swap)(void *);
static void (*p_rfree)(void *);
static int (*p_rget_info)(void *, mpv_render_param);
static int64_t (*p_get_time_us)(void *);

static void *lib;
static uint32_t maxw, maxh;
static volatile int quit;
static uint8_t scratch[16 * 16 * 4];                   /* the target of a frame that is skipped, not drawn */

static void say(const char *what) { printf("%s\n", what); fflush(stdout); }

#ifdef _WIN32
static HANDLE wake, parent_h;
static void *sym(const char *n) { return (void *)GetProcAddress((HMODULE)lib, n); }
static int load_one(const char *p) {
  wchar_t w[2048];
  if (!MultiByteToWideChar(CP_UTF8, 0, p, -1, w, 2048)) return 0;
  lib = (wcschr(w, L'\\') || wcschr(w, L'/')) ? (void *)LoadLibraryExW(w, NULL, LOAD_WITH_ALTERED_SEARCH_PATH) : (void *)LoadLibraryW(w);
  return lib != NULL;
}
static void on_update(void *c) { (void)c; SetEvent(wake); }
static void wait_wake(int ms) { WaitForSingleObject(wake, (DWORD)ms); }
static int parent_gone(void) { return parent_h && WaitForSingleObject(parent_h, 0) == WAIT_OBJECT_0; }
static void sleep_us(int64_t us) { Sleep((DWORD)((us + 999) / 1000)); }   /* 1 ms steps: timeBeginPeriod(1) at start */
static uint64_t now_us(void) { LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); return (uint64_t)(c.QuadPart * 1000000.0 / f.QuadPart); }
static DWORD WINAPI stdin_watch(LPVOID a) {
  (void)a; char b[64]; DWORD n = 0; HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  while (ReadFile(in, b, sizeof b, &n, NULL) && n > 0) {}
  quit = 1; SetEvent(wake);
  return 0;
}
static void watch_stdin(void) {
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  if (in && in != INVALID_HANDLE_VALUE && GetFileType(in) == FILE_TYPE_PIPE) { HANDLE t = CreateThread(NULL, 0, stdin_watch, NULL, 0, NULL); if (t) CloseHandle(t); }
}
static void watch_parent(const char *pid) { parent_h = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)atol(pid)); wake = CreateEventA(NULL, FALSE, FALSE, NULL); timeBeginPeriod(1); }
#else
static pid_t parent_pid;
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int pending;
static void *sym(const char *n) { return dlsym(lib, n); }
static int load_one(const char *p) {
  /* the carried libmpv needs libmujs and libsixel from beside it: loaded first by path, the linker then finds them by name */
  if (strchr(p, '/')) {
    char d[1024]; snprintf(d, sizeof d, "%s", p);
    char *dir = dirname(d);
    const char *deps[] = { "libmujs.so.1", "libsixel.so.1" };
    for (int i = 0; i < 2; i++) { char q[1200]; snprintf(q, sizeof q, "%s/%s", dir, deps[i]); if (access(q, R_OK) == 0) dlopen(q, RTLD_NOW | RTLD_GLOBAL); }
  }
  lib = dlopen(p, RTLD_NOW | RTLD_GLOBAL);
  if (!lib) fprintf(stderr, "nebula-mpv: %s\n", dlerror());
  return lib != NULL;
}
static void on_update(void *c) { (void)c; pthread_mutex_lock(&mu); pending = 1; pthread_cond_signal(&cv); pthread_mutex_unlock(&mu); }
static void wait_wake(int ms) {
  struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
  ts.tv_nsec += (long)ms * 1000000L; ts.tv_sec += ts.tv_nsec / 1000000000L; ts.tv_nsec %= 1000000000L;
  pthread_mutex_lock(&mu);
  while (!pending && !quit) { if (pthread_cond_timedwait(&cv, &mu, &ts) != 0) break; }
  pending = 0;
  pthread_mutex_unlock(&mu);
}
static int parent_gone(void) { return getppid() != parent_pid; }
static void sleep_us(int64_t us) { struct timespec t = { (time_t)(us / 1000000), (long)(us % 1000000) * 1000L }; nanosleep(&t, NULL); }
static uint64_t now_us(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000000u + (uint64_t)t.tv_nsec / 1000u; }
static void on_term(int s) { (void)s; quit = 1; }
static void *stdin_watch(void *a) {
  (void)a; char b[64];
  for (;;) { ssize_t n = read(0, b, sizeof b); if (n > 0 || (n < 0 && errno == EINTR)) continue; break; }
  quit = 1; on_update(NULL);
  return NULL;
}
static void watch_stdin(void) {
  /* Node hands a child its stdin as a socket pair (a pipe elsewhere); a terminal or /dev/null is not watched */
  struct stat st;
  if (fstat(0, &st) == 0 && (S_ISFIFO(st.st_mode) || S_ISSOCK(st.st_mode))) { pthread_t t; if (pthread_create(&t, NULL, stdin_watch, NULL) == 0) pthread_detach(t); }
}
static void watch_parent(const char *pid) {
  parent_pid = (pid_t)atol(pid);
  prctl(PR_SET_PDEATHSIG, SIGTERM);                    /* the parent goes, this goes with it */
  signal(SIGTERM, on_term); signal(SIGINT, on_term); signal(SIGPIPE, SIG_IGN);
}
#endif

#define LOAD(p, n) do { *(void **)(&(p)) = sym(n); if (!(p)) { fprintf(stderr, "nebula-mpv: %s is missing from this libmpv\n", n); return 0; } } while (0)
static int resolve(void) {
  LOAD(p_create, "mpv_create"); LOAD(p_initialize, "mpv_initialize"); LOAD(p_set_option_string, "mpv_set_option_string");
  LOAD(p_wait_event, "mpv_wait_event"); LOAD(p_terminate_destroy, "mpv_terminate_destroy");
  LOAD(p_rcreate, "mpv_render_context_create"); LOAD(p_rset_update_callback, "mpv_render_context_set_update_callback");
  LOAD(p_rupdate, "mpv_render_context_update"); LOAD(p_render, "mpv_render_context_render");
  LOAD(p_report_swap, "mpv_render_context_report_swap"); LOAD(p_rfree, "mpv_render_context_free");
  LOAD(p_rget_info, "mpv_render_context_get_info"); LOAD(p_get_time_us, "mpv_get_time_us");
  return 1;
}

/* One libmpv, in this process alone (two builds in one process would share their FFmpeg by name): does it load, start,
   and make the software renderer? Nothing plays and no sound device is opened. */
static int probe(const char *p) {
  if (!load_one(p) || !resolve()) { say("ERROR this player library will not load"); return 4; }
  void *h = p_create();
  if (!h) { say("ERROR mpv_create"); return 6; }
  p_set_option_string(h, "vo", "libmpv"); p_set_option_string(h, "ao", "null");
  p_set_option_string(h, "idle", "yes"); p_set_option_string(h, "terminal", "no");
  if (p_initialize(h) < 0) { say("ERROR mpv would not start"); p_terminate_destroy(h); return 7; }
  mpv_render_param cp[] = { { RP_API_TYPE, (void *)"sw" }, { 0, NULL } };
  void *rc = NULL;
  int ok = p_rcreate(&rc, h, cp) >= 0 && rc;
  if (rc) p_rfree(rc);
  p_terminate_destroy(h);
  if (!ok) { say("ERROR this player library is too old to draw here"); return 8; }
  printf("OK %s\n", p); fflush(stdout);
  return 0;
}

static int run(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--probe") == 0) return probe(argv[2]);
  if (argc < 8) { fprintf(stderr, "usage: nebula-mpv <ipc> <max-w> <max-h> <parent-pid> <token> <origin> <libmpv>[|...] [option=value ...]\n"); return 2; }
  maxw = (uint32_t)atoi(argv[2]); maxh = (uint32_t)atoi(argv[3]);
  if (maxw < 16 || maxh < 16 || maxw > 4096 || maxh > 4096) { say("ERROR bad frame size"); return 2; }
  watch_parent(argv[4]);
  if (parent_gone()) return 3;
  watch_stdin();
  char cands[8192]; snprintf(cands, sizeof cands, "%s", argv[7]);
  int ok = 0;
  for (char *c = strtok(cands, "|"); c && !ok; c = strtok(NULL, "|")) ok = load_one(c) && resolve();
  if (!ok) { say("ERROR no player library could be loaded"); return 4; }
  int port = frames_init(maxw, maxh, argv[5], argv[6]);
  if (!port) { say("ERROR the frame server could not start"); return 5; }

  void *h = p_create();
  if (!h) { say("ERROR mpv_create"); return 6; }
  p_set_option_string(h, "vo", "libmpv");
  p_set_option_string(h, "input-ipc-server", argv[1]);
  p_set_option_string(h, "idle", "yes");
  p_set_option_string(h, "terminal", "no");
  for (int i = 8; i < argc; i++) {
    char *eq = strchr(argv[i], '=');
    if (!eq) continue;
    *eq = 0;
    p_set_option_string(h, argv[i], eq + 1);
    *eq = '=';
  }
  if (p_initialize(h) < 0) { say("ERROR mpv_initialize"); return 7; }
  mpv_render_param cp[] = { { RP_API_TYPE, (void *)"sw" }, { 0, NULL } };
  void *rc = NULL;
  if (p_rcreate(&rc, h, cp) < 0 || !rc) { say("ERROR the software renderer would not start"); p_terminate_destroy(h); return 8; }
  p_rset_update_callback(rc, on_update, NULL);
  printf("READY %d\n", port); fflush(stdout);

  uint32_t lastw = 0, lasth = 0, gen = 0;
  int lastpad = -1, wasidle = 1;
  uint64_t count = 0;
  while (!quit) {
    wait_wake(40);
    if (quit || parent_gone()) break;
    int gone = 0;
    for (;;) {
      mpv_event *e = p_wait_event(h, 0);
      if (!e || !e->event_id) break;
      if (e->event_id == EV_SHUTDOWN) { gone = 1; break; }
      if (e->event_id == EV_START_FILE) gen++;       /* frames carry it: the page knows the last file's from the new one's */
    }
    if (gone) break;
    uint64_t fl = p_rupdate(rc);
    uint32_t w, ht; int pad;
    frames_want(&w, &ht, &pad);
    if (w < 2) w = 2;
    if (ht < 2) ht = 2;
    if (w > maxw) w = maxw;
    if (ht > maxh) ht = maxh;
    int idle = frames_idle();
    if (wasidle && !idle) lastw = 0;                   /* the page looks again: the current frame at once, at the size it asks */
    wasidle = idle;
    if (!(fl & UPDATE_FRAME) && w == lastw && ht == lasth && pad == lastpad) continue;
    int64_t due = 0;
    if (fl & UPDATE_FRAME) {
      frame_info_t fi = { 0, 0 };
      mpv_render_param ip = { RP_NEXT_FRAME_INFO, &fi };
      if (p_rget_info(rc, ip) >= 0) due = fi.target_time;
    }
    int block = 0, skip = 1;
    slot_t *s = idle ? NULL : frames_acquire();
    if (!s) {
      /* nobody is looking (a hidden window), or every slot is going out: mpv's clock moves on, nothing is drawn */
      int sz[2] = { 16, 16 }; size_t st = 64;
      mpv_render_param rp[] = { { RP_SW_SIZE, sz }, { RP_SW_FORMAT, (void *)"rgb0" }, { RP_SW_STRIDE, &st }, { RP_SW_POINTER, scratch },
        { RP_BLOCK, &block }, { RP_SKIP, &skip }, { 0, NULL } };
      p_render(rc, rp);
      p_report_swap(rc);
      continue;
    }
    uint32_t stride = pad ? ((w * 4u + 63u) & ~63u) : w * 4u;
    int size[2] = { (int)w, (int)ht };
    size_t sstride = stride;
    mpv_render_param rp[] = { { RP_SW_SIZE, size }, { RP_SW_FORMAT, (void *)"rgb0" }, { RP_SW_STRIDE, &sstride }, { RP_SW_POINTER, s->px },
      { RP_BLOCK, &block }, { 0, NULL } };
    uint64_t t0 = now_us();
    if (p_render(rc, rp) < 0) { p_report_swap(rc); continue; }
    s->drawus = (uint32_t)(now_us() - t0);
    s->w = w; s->h = ht; s->stride = stride; s->gen = gen; s->count = ++count;
    /* drawn at once, published at the moment mpv wants it on screen — less the few ms the page needs to fetch it (mpv's
       blocking render would wait inside the call, where the wait reads as drawing time) */
    if (due > 0) { int64_t d = due - p_get_time_us(h) - 4000; if (d > 0 && d < 250000) sleep_us(d); }
    frames_publish(s);
    p_report_swap(rc);
    lastw = w; lasth = ht; lastpad = pad;
  }
  p_rfree(rc);
  p_terminate_destroy(h);
  return 0;
}

#ifdef _WIN32
int wmain(int argc, wchar_t **wargv) {
  char **argv = calloc((size_t)argc + 1, sizeof *argv);
  if (!argv) return 2;
  for (int i = 0; i < argc; i++) {
    int n = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, NULL, 0, NULL, NULL);
    argv[i] = malloc(n > 0 ? (size_t)n : 1);
    if (!argv[i]) return 2;
    if (n > 0) WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, argv[i], n, NULL, NULL); else argv[i][0] = 0;
  }
  return run(argc, argv);
}
#else
int main(int argc, char **argv) { return run(argc, argv); }
#endif
