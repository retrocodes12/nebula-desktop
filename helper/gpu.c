/* gpu.c — the GPU's way of drawing (Linux). libmpv's OpenGL renderer draws each frame on the graphics chip into a buffer
 * the window can show WITHOUT a copy: a GBM buffer, handed over as a dmabuf that Electron imports as a shared texture
 * (mpv-gpu.js). The software renderer's frames cost a core to carry through the page (1.5 MB each over loopback HTTP, then
 * a WebGL upload: measured 09-29 on an i3-3217U, ~1.1 cores at 24 fps); this costs about a fifth of one.
 *
 * An EGL context with no window (EGL_KHR_surfaceless_context) on the first render node that gives one; NBUF buffers of the
 * wanted size, each an EGL image bound to a texture in a framebuffer. Everything is looked up at run time (dlopen): a
 * computer without Mesa's libgbm/libEGL, or whose driver lacks a step, answers 0 from gpu_init and the helper draws in
 * software as before. Lines on stdout tell the main process what exists:
 *   BUF <serial> <index> <count> <w> <h> <fd> <stride> <offset> <modifier>   one per buffer, whenever the size changes
 * The descriptor is this process's; the main process takes its own copy (pidfd_getfd) before the next size change closes it
 * (each set's descriptors have numbers of their own, so a line read too late names nothing rather than a newer buffer).
 *
 * VA-API (hardware decoding) gets a descriptor of its OWN for the same node: on the one the GL driver uses, libva's driver
 * and Mesa both hand out buffer handles and free each other's — the GL driver then crashes in the next upload (09-30).
 */
#ifndef _WIN32
#define _GNU_SOURCE
#include "nebula-mpv.h"
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define NBUF 4                                         /* one being shown, one on its way, one being drawn, one spare */
#define EGL_PLATFORM_GBM 0x31D7
#define EGL_EXTENSIONS 0x3055
#define EGL_NONE 0x3038
#define EGL_RENDERABLE_TYPE 0x3040
#define EGL_OPENGL_API 0x30A2
#define EGL_OPENGL_ES_API 0x30A0
#define EGL_NATIVE_PIXMAP 0x30B0
#define GL_TEXTURE_2D 0x0DE1
#define GL_FRAMEBUFFER 0x8D40
#define GBM_ARGB8888 0x34325241u                       /* 'AR24': blue, green, red, alpha — what the window imports as bgra */
#define FD_BASE 400                                    /* the buffers' descriptors are numbered from here, a range a set (below) */
#define FD_SETS 16
#define GBM_USE_RENDERING (1u << 2)

static void *gbm, *egl, *dev, *dpy, *ctx;
static int node = -1, vafd = -1;
static uint32_t serial, bw, bh;
static int nextbuf;
static struct { void *bo, *img; unsigned tex, fbo; int fd; } buf[NBUF];

static void *(*gbm_create_device)(int);
static void *(*gbm_bo_create)(void *, uint32_t, uint32_t, uint32_t, uint32_t);
static void (*gbm_bo_destroy)(void *);
static int (*gbm_bo_get_fd)(void *);
static uint32_t (*gbm_bo_get_stride)(void *);
static uint64_t (*gbm_bo_get_modifier)(void *);
static int (*gbm_bo_get_plane_count)(void *);
static void (*gbm_device_destroy)(void *);
static void *(*eglGetPlatformDisplay)(unsigned, void *, const intptr_t *);
static unsigned (*eglInitialize)(void *, int *, int *);
static unsigned (*eglTerminate)(void *);
static unsigned (*eglBindAPI)(unsigned);
static unsigned (*eglChooseConfig)(void *, const int *, void **, int, int *);
static void *(*eglCreateContext)(void *, void *, void *, const int *);
static unsigned (*eglMakeCurrent)(void *, void *, void *, void *);
static const char *(*eglQueryString)(void *, int);
static void *(*eglGetProcAddress)(const char *);
static void *(*eglCreateImageKHR)(void *, void *, unsigned, void *, const int *);
static unsigned (*eglDestroyImageKHR)(void *, void *);
static void (*glGenTextures)(int, unsigned *);
static void (*glDeleteTextures)(int, const unsigned *);
static void (*glBindTexture)(unsigned, unsigned);
static void (*glTexParameteri)(unsigned, unsigned, int);
static void (*glGenFramebuffers)(int, unsigned *);
static void (*glDeleteFramebuffers)(int, const unsigned *);
static void (*glBindFramebuffer)(unsigned, unsigned);
static void (*glFramebufferTexture2D)(unsigned, unsigned, unsigned, unsigned, int);
static unsigned (*glCheckFramebufferStatus)(unsigned);
static void (*glEGLImageTargetTexture2DOES)(unsigned, void *);
static void (*glViewport)(int, int, int, int);
static void (*glClearColor)(float, float, float, float);
static void (*glClear)(unsigned);
static void (*glFinish)(void);
static void (*glColorMask)(unsigned char, unsigned char, unsigned char, unsigned char);
static void (*glDisable)(unsigned);
static void (*glReadPixels)(int, int, int, int, unsigned, unsigned, void *);

#define SYM(lib, f) do { *(void **)(&(f)) = dlsym(lib, #f); if (!(f)) return 0; } while (0)
#define GLF(f) do { *(void **)(&(f)) = eglGetProcAddress(#f); if (!(f)) return 0; } while (0)
static int load_libs(void) {
  gbm = dlopen("libgbm.so.1", RTLD_NOW | RTLD_GLOBAL); egl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_GLOBAL);
  if (!gbm || !egl) return 0;
  SYM(gbm, gbm_create_device); SYM(gbm, gbm_bo_create); SYM(gbm, gbm_bo_destroy); SYM(gbm, gbm_bo_get_fd); SYM(gbm, gbm_bo_get_stride);
  SYM(gbm, gbm_device_destroy);
  *(void **)(&gbm_bo_get_modifier) = dlsym(gbm, "gbm_bo_get_modifier");          /* these two are newer than the rest: optional */
  *(void **)(&gbm_bo_get_plane_count) = dlsym(gbm, "gbm_bo_get_plane_count");
  SYM(egl, eglGetPlatformDisplay); SYM(egl, eglInitialize); SYM(egl, eglTerminate); SYM(egl, eglBindAPI); SYM(egl, eglChooseConfig);
  SYM(egl, eglCreateContext); SYM(egl, eglMakeCurrent); SYM(egl, eglQueryString); SYM(egl, eglGetProcAddress);
  return 1;
}
/* A context of the newest kind the driver gives: desktop GL 3.3 core (what mpv asks of a window), any desktop GL, GL ES 3. */
static int make_context(void) {
  void *cfg = NULL; int n = 0;
  const int core[] = { 0x3098, 3, 0x30FB, 3, 0x30FD, 1, EGL_NONE }, es3[] = { 0x3098, 3, EGL_NONE };
  const int glcfg[] = { EGL_RENDERABLE_TYPE, 0x0008, EGL_NONE }, escfg[] = { EGL_RENDERABLE_TYPE, 0x0040, EGL_NONE };
  if (eglBindAPI(EGL_OPENGL_API)) {
    if (!eglChooseConfig(dpy, glcfg, &cfg, 1, &n) || n < 1) cfg = NULL;
    ctx = eglCreateContext(dpy, cfg, NULL, core);
    if (!ctx) ctx = eglCreateContext(dpy, cfg, NULL, NULL);
  }
  if (!ctx && eglBindAPI(EGL_OPENGL_ES_API)) {
    if (!eglChooseConfig(dpy, escfg, &cfg, 1, &n) || n < 1) cfg = NULL;
    ctx = eglCreateContext(dpy, cfg, NULL, es3);
  }
  return ctx && eglMakeCurrent(dpy, NULL, NULL, ctx);
}
static int try_node(const char *path) {
  int ma = 0, mi = 0;
  node = open(path, O_RDWR | O_CLOEXEC);
  if (node < 0) return 0;
  dev = gbm_create_device(node);
  dpy = dev ? eglGetPlatformDisplay(EGL_PLATFORM_GBM, dev, NULL) : NULL;
  if (dpy && eglInitialize(dpy, &ma, &mi)) {
    const char *ext = eglQueryString(dpy, EGL_EXTENSIONS);
    if (ext && strstr(ext, "EGL_KHR_surfaceless_context") && strstr(ext, "EGL_KHR_image_base") && make_context()) return 1;
    eglTerminate(dpy);
  }
  if (dev) gbm_device_destroy(dev);
  close(node);
  dev = dpy = ctx = NULL; node = -1;
  return 0;
}

int gpu_init(void) {
  for (int i = 0; i < NBUF; i++) buf[i].fd = -1;        /* (0 is a real descriptor — the helper's stdin: never "none") */
  if (!load_libs()) return 0;
  int ok = 0;
  for (int i = 128; i < 136 && !ok; i++) { char p[40]; snprintf(p, sizeof p, "/dev/dri/renderD%d", i); ok = try_node(p); }
  if (!ok) return 0;
  GLF(eglCreateImageKHR); GLF(eglDestroyImageKHR);
  GLF(glGenTextures); GLF(glDeleteTextures); GLF(glBindTexture); GLF(glTexParameteri); GLF(glGenFramebuffers); GLF(glDeleteFramebuffers);
  GLF(glBindFramebuffer); GLF(glFramebufferTexture2D); GLF(glCheckFramebufferStatus); GLF(glEGLImageTargetTexture2DOES);
  GLF(glViewport); GLF(glClearColor); GLF(glClear); GLF(glFinish); GLF(glColorMask); GLF(glDisable); GLF(glReadPixels);
  char p[64]; snprintf(p, sizeof p, "/proc/self/fd/%d", node);
  vafd = open(p, O_RDWR | O_CLOEXEC);                   /* the same node, opened again: a descriptor of its own for VA-API */
  return vafd >= 0;
}
void *gpu_proc(void *c, const char *name) { (void)c; return eglGetProcAddress(name); }
int gpu_va_fd(void) { return vafd; }

static void drop_bufs(void) {
  for (int i = 0; i < NBUF; i++) {
    if (buf[i].fbo) glDeleteFramebuffers(1, &buf[i].fbo);
    if (buf[i].tex) glDeleteTextures(1, &buf[i].tex);
    if (buf[i].img) eglDestroyImageKHR(dpy, buf[i].img);
    if (buf[i].fd > 2) close(buf[i].fd);
    if (buf[i].bo) gbm_bo_destroy(buf[i].bo);
    buf[i].bo = buf[i].img = NULL; buf[i].tex = buf[i].fbo = 0; buf[i].fd = -1;
  }
}
/* NBUF buffers of w x h, each one told to the main process. 0 = the driver would not make them (the old ones are gone too). */
int gpu_size(uint32_t w, uint32_t h) {
  drop_bufs();
  bw = bh = 0;
  for (int i = 0; i < NBUF; i++) {
    buf[i].bo = gbm_bo_create(dev, w, h, GBM_ARGB8888, GBM_USE_RENDERING);
    if (!buf[i].bo || (gbm_bo_get_plane_count && gbm_bo_get_plane_count(buf[i].bo) != 1)) { drop_bufs(); return 0; }
    buf[i].img = eglCreateImageKHR(dpy, NULL, EGL_NATIVE_PIXMAP, buf[i].bo, NULL);
    /* its descriptor, at a number of this set's own (the next set's are others): a line about an older set, read late by
       the main process, then names a closed descriptor — never the newer buffer that would have taken the same number */
    int fd = gbm_bo_get_fd(buf[i].bo);
    buf[i].fd = fd < 0 ? -1 : fcntl(fd, F_DUPFD_CLOEXEC, FD_BASE + (int)((serial + 1) % FD_SETS) * NBUF + i);
    if (fd >= 0) close(fd);
    if (!buf[i].img || buf[i].fd < 0) { drop_bufs(); return 0; }
    glGenTextures(1, &buf[i].tex); glGenFramebuffers(1, &buf[i].fbo);
    glBindTexture(GL_TEXTURE_2D, buf[i].tex);
    glTexParameteri(GL_TEXTURE_2D, 0x2801, 0x2601); glTexParameteri(GL_TEXTURE_2D, 0x2800, 0x2601);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, buf[i].img);
    glBindFramebuffer(GL_FRAMEBUFFER, buf[i].fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, 0x8CE0, GL_TEXTURE_2D, buf[i].tex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != 0x8CD5) { drop_bufs(); return 0; }
  }
  glBindTexture(GL_TEXTURE_2D, 0); glBindFramebuffer(GL_FRAMEBUFFER, 0);
  serial++; bw = w; bh = h; nextbuf = 0;
  for (int i = 0; i < NBUF; i++)
    printf("BUF %u %d %d %u %u %d %u 0 %llu\n", serial, i, NBUF, w, h, buf[i].fd, gbm_bo_get_stride(buf[i].bo),
      gbm_bo_get_modifier ? (unsigned long long)gbm_bo_get_modifier(buf[i].bo) : 0x00ffffffffffffffull);
  fflush(stdout);
  return 1;
}
uint32_t gpu_serial(void) { return serial; }
void gpu_have(uint32_t *w, uint32_t *h) { *w = bw; *h = bh; }
/* The buffer to draw the next frame into (each in turn: the window has long finished with one by the time it comes round). */
int gpu_next(void) { int i = nextbuf; nextbuf = (nextbuf + 1) % NBUF; return i; }
unsigned gpu_fbo(int i) { return buf[i].fbo; }
/* The frame in buffer i is complete: every pixel made opaque (the window reads the fourth byte as alpha and would divide
   the colours by it — an HDR film came out too bright, 09-30), and the drawing has reached the buffer. */
void gpu_finish(int i) {
  static int traced = -1, every;
  if (traced < 0) { const char *t = getenv("NEBULA_GPU_TRACE"); traced = t && t[0] == '1'; }
  glBindFramebuffer(GL_FRAMEBUFFER, buf[i].fbo);
  if (traced && ++every % 24 == 0) {                   /* (a test's trace: what this buffer holds, read back here) */
    unsigned char a[4] = { 0 };
    glReadPixels((int)bw / 4, (int)bh / 4, 1, 1, 0x1908, 0x1401, a);
    fprintf(stderr, "nebula-mpv: trace set %u buffer %d %ux%u drawn %u %u %u %u\n", serial, i, bw, bh, a[0], a[1], a[2], a[3]); fflush(stderr);
  }
  glDisable(0x0C11);                                   /* (scissor) */
  glColorMask(0, 0, 0, 1); glClearColor(0.0f, 0.0f, 0.0f, 1.0f); glClear(0x4000); glColorMask(1, 1, 1, 1);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glFinish();
}
/* One colour over buffer i: the start-up check's picture (the window must read this colour back before GPU frames are trusted). */
/* A grid of the picture in buffer i, read back here, for the main process to hold against mpv's own screenshot of the same
   film (mpv-host.js): "P <serial> <w> <h> <cols> <rows> r g b …", row by row from the picture's top (the buffers' first row
   is the picture's top: RP_FLIP_Y 0). */
void gpu_probe(int i) {
  enum { COLS = 12, ROWS = 8 };
  static int probes;                                   /* (a rig's: the check must see a wrong picture and go to software —
                                                          1 = every grid black, 2 = every one after the first) */
  const char *bk = getenv("NEBULA_GPU_PROBE_BLACK");
  int black = bk && (bk[0] == '1' || (bk[0] == '2' && probes > 0));
  probes++;
  glBindFramebuffer(GL_FRAMEBUFFER, buf[i].fbo);
  printf("P %u %u %u %d %d", serial, bw, bh, COLS, ROWS);
  for (int r = 0; r < ROWS; r++)
    for (int c = 0; c < COLS; c++) {
      unsigned char px[4] = { 0, 0, 0, 0 };
      glReadPixels((int)((c * 2 + 1) * bw / (COLS * 2)), (int)((r * 2 + 1) * bh / (ROWS * 2)), 1, 1, 0x1908, 0x1401, px);
      if (black) px[0] = px[1] = px[2] = 0;
      printf(" %u %u %u", px[0], px[1], px[2]);
    }
  printf("\n"); fflush(stdout);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
}
void gpu_fill(int i, float r, float g, float b) {
  glBindFramebuffer(GL_FRAMEBUFFER, buf[i].fbo); glViewport(0, 0, (int)bw, (int)bh);
  glClearColor(r, g, b, 1.0f); glClear(0x4000); glFinish();
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
}
void gpu_free(void) {
  if (!dpy) return;
  drop_bufs();
  eglMakeCurrent(dpy, NULL, NULL, NULL);
  eglTerminate(dpy);
  if (dev) gbm_device_destroy(dev);
  if (vafd > 2) close(vafd);
  if (node > 2) close(node);
  dpy = dev = ctx = NULL; node = vafd = -1;
}
#endif
