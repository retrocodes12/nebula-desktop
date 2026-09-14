/* nebula-mpv — libmpv in a process of its own, for Nebula's full-format player (desktop).
 *
 * The page cannot host libmpv on Linux: Electron's own FFmpeg (libffmpeg.so, unversioned symbols) and its libvulkan sit
 * first in that process's symbol scope, and libmpv's calls land in them — an ABI mismatch that aborts (measured 09-15;
 * a second link-map namespace segfaulted inside Electron too). Here libmpv runs the way the mpv player runs it: a plain
 * process with the system's own libraries. Every frame is drawn by libmpv's software renderer into shared memory the page
 * maps — two slots, the page reads the finished one while the next is drawn — and mpv's own JSON IPC server
 * (input-ipc-server) carries commands, properties and events. The helper exits when mpv quits, when its parent goes, or
 * when its stdin (a pipe from the page that started it) closes — a page that reloads leaves no helper behind.
 *
 *   nebula-mpv <shm> <ipc> <max-w> <max-h> <parent-pid> <libmpv>[|<libmpv>...] [option=value ...]
 *   nebula-mpv --probe <libmpv>     "OK <libmpv>" (exit 0) when it loads, starts and can draw in software; else "ERROR <why>"
 *                                   and exit 4 (will not load), 6/7 (mpv will not be made / start), 8 (too old to draw here)
 *
 * <shm> is a file path on Linux (/dev/shm/...), a mapping name on Windows (Local\...). Its layout: a 64-byte header, then
 * two frames of max-w x max-h x 4 bytes (rgb0).
 *   u32 magic 'NMPV' | u32 version 1 | u32 maxw | u32 maxh | u32 wantw | u32 wanth  (the page writes these two)
 *   u32 cur (the finished slot) | u32 state (1 up, 2 gone) | u32 w[2] | u32 h[2] | u64 frames | u32 drawus | u32 pad
 */
#ifndef _WIN32
#define _GNU_SOURCE
#endif
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#include <mmsystem.h>                                  /* timeBeginPeriod: link -lwinmm */
#else
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <libgen.h>
#include <pthread.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#endif

typedef struct { int type; void *data; } mpv_render_param;
typedef struct { int event_id; int error; uint64_t reply_userdata; void *data; } mpv_event;
enum { EV_SHUTDOWN = 1, RP_API_TYPE = 1, RP_NEXT_FRAME_INFO = 11, RP_BLOCK = 12, RP_SW_SIZE = 17, RP_SW_FORMAT = 18, RP_SW_STRIDE = 19,
  RP_SW_POINTER = 20, UPDATE_FRAME = 1 };
typedef struct { uint32_t magic, version, maxw, maxh, wantw, wanth, cur, state, w[2], h[2]; uint64_t frames; uint32_t drawus, pad; } header_t;
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
static header_t *hdr;
static uint8_t *slots;
static size_t shm_size;
static uint32_t maxw, maxh;
static volatile int quit;

static void say(const char *what) { printf("%s\n", what); fflush(stdout); }

#ifdef _WIN32
static HANDLE shm_h, wake, parent_h;
static void *sym(const char *n) { return (void *)GetProcAddress((HMODULE)lib, n); }
static int load_one(const char *p) {
  lib = (strchr(p, '\\') || strchr(p, '/')) ? (void *)LoadLibraryExA(p, NULL, LOAD_WITH_ALTERED_SEARCH_PATH) : (void *)LoadLibraryA(p);
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
static int shm_create(const char *name) {
  shm_h = CreateFileMappingA(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, (DWORD)(shm_size >> 32), (DWORD)(shm_size & 0xffffffffu), name);
  if (!shm_h) return 0;
  void *m = MapViewOfFile(shm_h, FILE_MAP_ALL_ACCESS, 0, 0, shm_size);
  if (!m) return 0;
  hdr = (header_t *)m;
  return 1;
}
static void shm_release(void) { if (hdr) UnmapViewOfFile(hdr); if (shm_h) CloseHandle(shm_h); }
#else
static char shm_path[1024];
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
static int shm_create(const char *name) {
  snprintf(shm_path, sizeof shm_path, "%s", name);
  int fd = open(shm_path, O_RDWR | O_CREAT | O_EXCL, 0600);
  if (fd < 0) return 0;
  if (ftruncate(fd, (off_t)shm_size) != 0) { close(fd); unlink(shm_path); return 0; }
  void *m = mmap(NULL, shm_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  close(fd);
  if (m == MAP_FAILED) { unlink(shm_path); return 0; }
  hdr = (header_t *)m;
  return 1;
}
static void shm_release(void) { if (hdr) munmap(hdr, shm_size); unlink(shm_path); }
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

int main(int argc, char **argv) {
  if (argc == 3 && strcmp(argv[1], "--probe") == 0) return probe(argv[2]);
  if (argc < 7) { fprintf(stderr, "usage: nebula-mpv <shm> <ipc> <max-w> <max-h> <parent-pid> <libmpv>[|...] [option=value ...]\n"); return 2; }
  maxw = (uint32_t)atoi(argv[3]); maxh = (uint32_t)atoi(argv[4]);
  if (maxw < 16 || maxh < 16 || maxw > 4096 || maxh > 4096) { say("ERROR bad frame size"); return 2; }
#ifdef _WIN32
  parent_h = OpenProcess(SYNCHRONIZE, FALSE, (DWORD)atol(argv[5]));
  wake = CreateEventA(NULL, FALSE, FALSE, NULL);
  timeBeginPeriod(1);                                /* waits in 1 ms steps, not 15.6 ms */
#else
  parent_pid = (pid_t)atol(argv[5]);
  prctl(PR_SET_PDEATHSIG, SIGTERM);                  /* the page's process goes, this goes with it */
  if (getppid() != parent_pid) return 3;
  signal(SIGTERM, on_term); signal(SIGINT, on_term); signal(SIGPIPE, SIG_IGN);
#endif
  watch_stdin();
  char cands[8192]; snprintf(cands, sizeof cands, "%s", argv[6]);
  int ok = 0;
  for (char *c = strtok(cands, "|"); c && !ok; c = strtok(NULL, "|")) ok = load_one(c) && resolve();
  if (!ok) { say("ERROR no player library could be loaded"); return 4; }
  shm_size = sizeof(header_t) + 2u * (size_t)maxw * maxh * 4u;
  if (!shm_create(argv[1])) { say("ERROR the frame memory could not be made"); return 5; }
  memset(hdr, 0, sizeof *hdr);
  hdr->magic = 0x564d504eu; hdr->version = 1; hdr->maxw = maxw; hdr->maxh = maxh; hdr->wantw = 640; hdr->wanth = 360;
  slots = (uint8_t *)hdr + sizeof(header_t);

  void *h = p_create();
  if (!h) { say("ERROR mpv_create"); shm_release(); return 6; }
  p_set_option_string(h, "vo", "libmpv");
  p_set_option_string(h, "input-ipc-server", argv[2]);
  p_set_option_string(h, "idle", "yes");
  p_set_option_string(h, "terminal", "no");
  for (int i = 7; i < argc; i++) {
    char *eq = strchr(argv[i], '=');
    if (!eq) continue;
    *eq = 0;
    p_set_option_string(h, argv[i], eq + 1);
    *eq = '=';
  }
  if (p_initialize(h) < 0) { say("ERROR mpv_initialize"); shm_release(); return 7; }
  mpv_render_param cp[] = { { RP_API_TYPE, (void *)"sw" }, { 0, NULL } };
  void *rc = NULL;
  if (p_rcreate(&rc, h, cp) < 0 || !rc) { say("ERROR the software renderer would not start"); p_terminate_destroy(h); shm_release(); return 8; }
  p_rset_update_callback(rc, on_update, NULL);
  hdr->state = 1;
  printf("READY %u %u\n", maxw, maxh); fflush(stdout);

  uint32_t lastw = 0, lasth = 0;
  while (!quit) {
    wait_wake(40);
    if (quit || parent_gone()) break;
    int gone = 0;
    for (;;) { mpv_event *e = p_wait_event(h, 0); if (!e || !e->event_id) break; if (e->event_id == EV_SHUTDOWN) { gone = 1; break; } }
    if (gone) break;
    uint64_t fl = p_rupdate(rc);
    uint32_t w = hdr->wantw, ht = hdr->wanth;
    if (w < 2) w = 2;
    if (ht < 2) ht = 2;
    if (w > maxw) w = maxw;
    if (ht > maxh) ht = maxh;
    if (!(fl & UPDATE_FRAME) && w == lastw && ht == lasth) continue;
    /* the frame is drawn at once and published at the moment mpv wants it on screen (its own clock) — mpv's blocking
       render would do the same wait, but inside the call, where it reads as drawing time */
    int64_t due = 0;
    if (fl & UPDATE_FRAME) {
      frame_info_t fi = { 0, 0 };
      mpv_render_param ip = { RP_NEXT_FRAME_INFO, &fi };
      if (p_rget_info(rc, ip) >= 0) due = fi.target_time;
    }
    uint32_t slot = hdr->cur ? 0u : 1u;              /* the slot the page is not reading */
    int size[2] = { (int)w, (int)ht };
    size_t stride = (size_t)w * 4u;
    int block = 0;
    mpv_render_param rp[] = { { RP_SW_SIZE, size }, { RP_SW_FORMAT, (void *)"rgb0" }, { RP_SW_STRIDE, &stride },
      { RP_SW_POINTER, slots + (size_t)slot * maxw * maxh * 4u }, { RP_BLOCK, &block }, { 0, NULL } };
    uint64_t t0 = now_us();
    if (p_render(rc, rp) < 0) continue;
    hdr->drawus = (uint32_t)(now_us() - t0);
    if (due > 0) { int64_t d = due - p_get_time_us(h); if (d > 0 && d < 250000) sleep_us(d); }
    hdr->w[slot] = w; hdr->h[slot] = ht;
    __atomic_store_n(&hdr->cur, slot, __ATOMIC_RELEASE);
    __atomic_add_fetch(&hdr->frames, 1, __ATOMIC_RELEASE);
    p_report_swap(rc);
    lastw = w; lasth = ht;
  }
  hdr->state = 2;
  p_rfree(rc);
  p_terminate_destroy(h);
  shm_release();
  return 0;
}
