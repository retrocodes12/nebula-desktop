/* frames.c — the frame server. The page stays sandboxed (no shared memory, no sockets of its own), but it can fetch: every
 * finished frame goes to it over loopback HTTP, one request per frame.
 *   GET /<token>/f?after=<count>&w=<w>&h=<h>&pad=<0|1> HTTP/1.1
 * answers with the newest frame as soon as there is one newer than <count> (200; after a second with none, 204), and asks
 * the drawing for <w>x<h> from then on. The body is a 32-byte header — u32 'NMPF', w, h, stride, drawus, gen, then the u64
 * count — and h rows of <stride> bytes of rgb0. pad=1 rounds each row up to 64 bytes (the renderer's fast path; a WebGL2
 * page skips the padding), pad=0 packs them. Keep-alive; at most MAXCONN connections; 127.0.0.1 only; the token comes from
 * the command line and anything else is refused. NSLOTS buffers: a slot is never drawn into while it is being sent.
 */
#ifndef _WIN32
#define _GNU_SOURCE
#endif
#include "nebula-mpv.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <malloc.h>
#include <ws2tcpip.h>
typedef SOCKET sock_t;
#define BAD_SOCK INVALID_SOCKET
#define SEND_FLAGS 0
static CRITICAL_SECTION mu;
static CONDITION_VARIABLE cv;
static void lock(void) { EnterCriticalSection(&mu); }
static void unlock(void) { LeaveCriticalSection(&mu); }
static void wake_all(void) { WakeAllConditionVariable(&cv); }
static void wait_ms(int ms) { SleepConditionVariableCS(&cv, &mu, (DWORD)ms); }
static uint64_t now_ms(void) { return (uint64_t)GetTickCount64(); }
static void close_sock(sock_t s) { closesocket(s); }
static void no_inherit(sock_t s) { SetHandleInformation((HANDLE)s, HANDLE_FLAG_INHERIT, 0); }
static void *alloc64(size_t n) { return _aligned_malloc(n, 64); }
static void nap(void) { Sleep(50); }
typedef struct { void (*fn)(void *); void *arg; } tramp_t;
static DWORD WINAPI tramp(LPVOID p) { tramp_t t = *(tramp_t *)p; free(p); t.fn(t.arg); return 0; }
static int spawn(void (*fn)(void *), void *arg) {
  tramp_t *t = malloc(sizeof *t);
  if (!t) return 0;
  t->fn = fn; t->arg = arg;
  HANDLE h = CreateThread(NULL, 0, tramp, t, 0, NULL);
  if (!h) { free(t); return 0; }
  CloseHandle(h);
  return 1;
}
#else
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
typedef int sock_t;
#define BAD_SOCK (-1)
#define SEND_FLAGS MSG_NOSIGNAL
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv;
static void lock(void) { pthread_mutex_lock(&mu); }
static void unlock(void) { pthread_mutex_unlock(&mu); }
static void wake_all(void) { pthread_cond_broadcast(&cv); }
static void wait_ms(int ms) {
  struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
  ts.tv_sec += ms / 1000; ts.tv_nsec += (long)(ms % 1000) * 1000000L;
  if (ts.tv_nsec >= 1000000000L) { ts.tv_sec++; ts.tv_nsec -= 1000000000L; }
  pthread_cond_timedwait(&cv, &mu, &ts);
}
static uint64_t now_ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000u + (uint64_t)t.tv_nsec / 1000000u; }
static void close_sock(sock_t s) { close(s); }
static void no_inherit(sock_t s) { (void)s; }         /* SOCK_CLOEXEC at creation */
static void *alloc64(size_t n) { void *p = NULL; return posix_memalign(&p, 64, n) == 0 ? p : NULL; }
static void nap(void) { struct timespec t = { 0, 50000000L }; nanosleep(&t, NULL); }
typedef struct { void (*fn)(void *); void *arg; } tramp_t;
static void *tramp(void *p) { tramp_t t = *(tramp_t *)p; free(p); t.fn(t.arg); return NULL; }
static int spawn(void (*fn)(void *), void *arg) {
  tramp_t *t = malloc(sizeof *t);
  if (!t) return 0;
  t->fn = fn; t->arg = arg;
  pthread_t th;
  if (pthread_create(&th, NULL, tramp, t) != 0) { free(t); return 0; }
  pthread_detach(th);
  return 1;
}
#endif

#define NSLOTS 4                                       /* MAXCONN being sent + the newest + one to draw into */
#define MAXCONN 2
static slot_t slots[NSLOTS];
static int newest = -1, conns = 0;
static uint32_t cap_w, cap_h, want_w = 640, want_h = 360;
static int want_pad = 1;
static uint64_t last_req;                              /* when the page last asked (ms); 0 = never */
static char pre[80], origin_hdr[220];
static size_t pre_len;
static sock_t lsock = BAD_SOCK;

static int send_all(sock_t c, const void *buf, size_t n) {
  const char *p = (const char *)buf;
  while (n) {
    int k = (int)(n > (1u << 28) ? (1u << 28) : n);
    int r = send(c, p, k, SEND_FLAGS);
    if (r <= 0) {
#ifndef _WIN32
      if (r < 0 && errno == EINTR) continue;
#endif
      return 0;
    }
    p += r; n -= (size_t)r;
  }
  return 1;
}
/* compares in constant time: the token must not be guessable a character at a time */
static int same(const char *a, const char *b, size_t n) { unsigned d = 0; for (size_t i = 0; i < n; i++) d |= (unsigned)(a[i] ^ b[i]); return d == 0; }
static int qget(const char *q, const char *key, uint64_t *out) {
  size_t k = strlen(key);
  for (const char *p = q; p && *p; ) {
    if (strncmp(p, key, k) == 0 && p[k] == '=') {
      uint64_t v = 0; int d = 0;
      for (p += k + 1; *p >= '0' && *p <= '9' && d < 19; p++, d++) v = v * 10u + (uint64_t)(*p - '0');
      *out = v;
      return 1;
    }
    p = strchr(p, '&');
    if (p) p++;
  }
  return 0;
}
static void reply(sock_t c, const char *status) {
  char h[400];
  int n = snprintf(h, sizeof h, "HTTP/1.1 %s\r\nContent-Length: 0\r\nCache-Control: no-store\r\n%s\r\n", status, origin_hdr);
  if (n > 0) send_all(c, h, (size_t)n);
}

static void serve(void *arg) {
  sock_t c = (sock_t)(uintptr_t)arg;
  char buf[4096];
  size_t n = 0;
  for (;;) {
    char *end;
    buf[n] = 0;
    while (!(end = strstr(buf, "\r\n\r\n"))) {
      if (n >= sizeof buf - 1) goto done;               /* a request this long is not the page's */
      int r = recv(c, buf + n, (int)(sizeof buf - 1 - n), 0);
      if (r <= 0) goto done;
      n += (size_t)r; buf[n] = 0;
    }
    size_t used = (size_t)(end - buf) + 4;
    *end = 0;
    char *sp1 = strchr(buf, ' '), *sp2 = sp1 ? strchr(sp1 + 1, ' ') : NULL;
    if (!sp1 || !sp2 || sp1 - buf != 3 || strncmp(buf, "GET", 3) != 0) { reply(c, "405 Method Not Allowed"); goto done; }
    *sp2 = 0;
    const char *target = sp1 + 1;
    if (strlen(target) < pre_len || !same(target, pre, pre_len) || (target[pre_len] && target[pre_len] != '?')) { reply(c, "404 Not Found"); goto done; }
    const char *q = target[pre_len] == '?' ? target + pre_len + 1 : "";
    uint64_t after = 0, v = 0;
    if (qget(q, "after", &v)) after = v;
    uint32_t w = qget(q, "w", &v) ? (uint32_t)(v > 8192 ? 8192 : v) : 0, h = qget(q, "h", &v) ? (uint32_t)(v > 8192 ? 8192 : v) : 0;
    int pad = qget(q, "pad", &v) ? (v != 0) : 1;
    int s = -1;
    slot_t meta;
    memset(&meta, 0, sizeof meta);
    lock();
    if (w >= 2 && h >= 2) { want_w = w > cap_w ? cap_w : w; want_h = h > cap_h ? cap_h : h; }
    want_pad = pad;
    last_req = now_ms();
    uint64_t t0 = last_req;
    for (;;) {
      if (newest >= 0 && slots[newest].count > after) { s = newest; slots[s].readers++; meta = slots[s]; break; }
      uint64_t el = now_ms() - t0;
      if (el >= 1000) break;
      wait_ms((int)(1000 - el));
    }
    unlock();
    int ok = 1;
    if (s < 0) reply(c, "204 No Content");
    else {
      char hd[420];
      unsigned long body = 32ul + (unsigned long)meta.h * meta.stride;
      int hn = snprintf(hd, sizeof hd, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: %lu\r\nCache-Control: no-store\r\n%s\r\n", body, origin_hdr);
      uint32_t fh[8] = { 0x46504d4eu, meta.w, meta.h, meta.stride, meta.drawus, meta.gen, (uint32_t)(meta.count & 0xffffffffu), (uint32_t)(meta.count >> 32) };
      ok = hn > 0 && send_all(c, hd, (size_t)hn) && send_all(c, fh, sizeof fh) && send_all(c, meta.px, (size_t)meta.h * meta.stride);
      lock(); slots[s].readers--; unlock();
    }
    if (!ok) goto done;
    memmove(buf, buf + used, n - used);
    n -= used;
  }
done:
  close_sock(c);
  lock(); conns--; unlock();
}

static void accept_loop(void *arg) {
  (void)arg;
  for (;;) {
#ifdef _WIN32
    sock_t c = accept(lsock, NULL, NULL);
#else
    sock_t c = accept4(lsock, NULL, NULL, SOCK_CLOEXEC);
#endif
    if (c == BAD_SOCK) { nap(); continue; }
    no_inherit(c);
    int one = 1;
    setsockopt(c, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
    lock();
    int room = conns < MAXCONN;
    if (room) conns++;
    unlock();
    if (!room) { close_sock(c); continue; }
    if (!spawn(serve, (void *)(uintptr_t)c)) { close_sock(c); lock(); conns--; unlock(); }
  }
}

int frames_init(uint32_t maxw, uint32_t maxh, const char *token, const char *origin) {
  size_t tl = strlen(token);
  if (tl < 16 || tl > 64 || strspn(token, "0123456789abcdef") != tl) return 0;
  cap_w = maxw; cap_h = maxh;
  pre_len = (size_t)snprintf(pre, sizeof pre, "/%s/f", token);
  if (origin && *origin && strlen(origin) < 150 && !strpbrk(origin, "\r\n")) snprintf(origin_hdr, sizeof origin_hdr, "Access-Control-Allow-Origin: %s\r\n", origin);
  size_t stride = ((size_t)maxw * 4u + 63u) & ~(size_t)63u;
  for (int i = 0; i < NSLOTS; i++) if (!(slots[i].px = alloc64(stride * maxh))) return 0;
#ifdef _WIN32
  InitializeCriticalSection(&mu);
  InitializeConditionVariable(&cv);
  WSADATA wd;
  if (WSAStartup(MAKEWORD(2, 2), &wd) != 0) return 0;
  lsock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (lsock == BAD_SOCK) return 0;
  no_inherit(lsock);
  BOOL excl = TRUE;                                    /* no other program may bind this port over ours */
  setsockopt(lsock, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&excl, sizeof excl);
#else
  pthread_condattr_t ca;
  pthread_condattr_init(&ca);
  pthread_condattr_setclock(&ca, CLOCK_MONOTONIC);
  pthread_cond_init(&cv, &ca);
  lsock = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, IPPROTO_TCP);
  if (lsock == BAD_SOCK) return 0;
#endif
  struct sockaddr_in a;
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = 0;
  if (bind(lsock, (struct sockaddr *)&a, sizeof a) != 0 || listen(lsock, 8) != 0) return 0;
  socklen_t al = sizeof a;
  if (getsockname(lsock, (struct sockaddr *)&a, &al) != 0) return 0;
  if (!spawn(accept_loop, NULL)) return 0;
  return ntohs(a.sin_port);
}
slot_t *frames_acquire(void) {
  slot_t *r = NULL;
  lock();
  for (int i = 0; i < NSLOTS && !r; i++) if (i != newest && slots[i].readers == 0) r = &slots[i];
  unlock();
  return r;
}
void frames_publish(slot_t *s) { lock(); newest = (int)(s - slots); wake_all(); unlock(); }
void frames_want(uint32_t *w, uint32_t *h, int *pad) { lock(); *w = want_w; *h = want_h; *pad = want_pad; unlock(); }
int frames_idle(void) { lock(); int idle = !last_req || now_ms() - last_req > 1500; unlock(); return idle; }
