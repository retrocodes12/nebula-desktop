/* gpu_win.c — the GPU's way of drawing (Windows). The Windows half of gpu.c: libmpv's OpenGL renderer draws each frame on
 * the graphics chip into a Direct3D 11 texture that the window shows WITHOUT a copy — shared by an NT handle, which Electron
 * imports as a shared texture (mpv-gpu.js). The software renderer's frames go through the page over loopback HTTP and a
 * WebGL upload; on Linux that cost more than a core for a 24 fps film (09-29) where this way costs a fifth of one.
 *
 * GL on Direct3D 11 is ANGLE — MSYS2's build, carried in resources/mpv/angle with the four MinGW runtime libraries it needs
 * (Electron keeps its own inside electron.exe; the main process names the folder in NEBULA_ANGLE_DIR). The helper makes its own D3D11
 * device (hardware; WARP when NEBULA_GPU_WARP=1, for a test machine without a graphics chip) and puts ANGLE on it
 * (EGL_ANGLE_device_creation); each of NBUF textures is an EGL image bound to a texture in a framebuffer. Everything is
 * looked up at run time: a computer or a build without a step answers 0 from gpu_init and the helper draws in software as
 * before. Lines on stdout, the same shape as gpu.c's:
 *   BUF <serial> <index> <count> <w> <h> <handle> <stride> 0 0   one per texture, whenever the size changes
 * The handle is the MAIN process's own (DuplicateHandle into it; Electron duplicates it again on import and never closes
 * it). The main process says when it has let go of a set — "D <serial>" on stdin — and this closes that set's handles in
 * it (DUPLICATE_CLOSE_SOURCE); whatever is left is closed at the end.
 */
#ifdef _WIN32
#define COBJMACROS
#include "nebula-mpv.h"
#include <initguid.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define NBUF 4                                         /* one being shown, one on its way, one being drawn, one spare */
#define KEEP 16                                        /* sets whose handles the main process may still hold */
#define EGL_NONE 0x3038
#define EGL_EXTENSIONS 0x3055
#define EGL_RENDERABLE_TYPE 0x3040
#define EGL_OPENGL_ES_API 0x30A0
#define EGL_OPENGL_ES3_BIT 0x0040
#define EGL_CONTEXT_CLIENT_VERSION 0x3098
#define EGL_PLATFORM_DEVICE_EXT 0x313F
#define EGL_D3D11_DEVICE_ANGLE 0x33A1
#define EGL_D3D11_TEXTURE_ANGLE 0x3484
#define GL_TEXTURE_2D 0x0DE1
#define GL_FRAMEBUFFER 0x8D40

unsigned long nebula_parent_pid;                       /* set by nebula-mpv.c: where the handles are duplicated to */

static HMODULE glesdll, egldll, d3ddll;
static ID3D11Device *dev;
static HANDLE parent;
static void *edev, *dpy, *ctx;
static uint32_t serial, bw, bh;
static int nextbuf;
static struct { ID3D11Texture2D *tex; void *img; unsigned gltex, fbo; HANDLE theirs; } buf[NBUF];
static struct { uint32_t serial; HANDLE h[NBUF]; } kept[KEEP];
static CRITICAL_SECTION keptcs;

typedef HRESULT (WINAPI *create_device_t)(void *, int, HMODULE, UINT, const int *, UINT, UINT, ID3D11Device **, int *, void **);
static void *(*eglGetProcAddress)(const char *);
static void *(*eglCreateDeviceANGLE)(int, void *, const intptr_t *);
static unsigned (*eglReleaseDeviceANGLE)(void *);
static void *(*eglGetPlatformDisplay)(unsigned, void *, const intptr_t *);
static unsigned (*eglInitialize)(void *, int *, int *);
static unsigned (*eglTerminate)(void *);
static unsigned (*eglBindAPI)(unsigned);
static unsigned (*eglChooseConfig)(void *, const int *, void **, int, int *);
static void *(*eglCreateContext)(void *, void *, void *, const int *);
static unsigned (*eglDestroyContext)(void *, void *);
static unsigned (*eglMakeCurrent)(void *, void *, void *, void *);
static const char *(*eglQueryString)(void *, int);
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

/* why the chip is not used, on stderr (the main process shows it with NEBULA_MPV_DEBUG): 0, for gpu_init */
static int no(const char *why) { fprintf(stderr, "nebula-mpv: graphics chip: %s\n", why); fflush(stderr); return 0; }

/* a DLL from the folder the main process named (Electron's own), else by name from the usual places */
static HMODULE load_from(const char *dir, const wchar_t *name) {
  if (dir && *dir) {
    wchar_t w[2048];
    int n = MultiByteToWideChar(CP_UTF8, 0, dir, -1, w, 2000);
    if (n > 0 && n + (int)wcslen(name) + 2 < 2048) {
      wcscat(w, L"\\"); wcscat(w, name);
      HMODULE m = LoadLibraryExW(w, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);   /* (its d3dcompiler_47.dll is found beside it) */
      if (m) return m;
    }
  }
  return LoadLibraryW(name);
}
#define SYM(lib, f) do { *(void **)(&(f)) = (void *)GetProcAddress(lib, #f); if (!(f)) return 0; } while (0)
#define EXT(f) do { *(void **)(&(f)) = eglGetProcAddress(#f); if (!(f)) return no("this ANGLE lacks " #f); } while (0)
static int load_libs(void) {
  const char *dir = getenv("NEBULA_ANGLE_DIR");
  glesdll = load_from(dir, L"libGLESv2.dll");          /* first: libEGL.dll needs it, and must find this one */
  egldll = load_from(dir, L"libEGL.dll");
  d3ddll = LoadLibraryW(L"d3d11.dll");
  if (!glesdll || !egldll || !d3ddll) return no(!glesdll ? "no libGLESv2.dll" : (!egldll ? "no libEGL.dll" : "no d3d11.dll"));
  SYM(egldll, eglGetProcAddress); SYM(egldll, eglGetPlatformDisplay); SYM(egldll, eglInitialize); SYM(egldll, eglTerminate);
  SYM(egldll, eglBindAPI); SYM(egldll, eglChooseConfig); SYM(egldll, eglCreateContext); SYM(egldll, eglDestroyContext);
  SYM(egldll, eglMakeCurrent); SYM(egldll, eglQueryString);
  *(void **)(&eglCreateDeviceANGLE) = eglGetProcAddress("eglCreateDeviceANGLE");
  *(void **)(&eglReleaseDeviceANGLE) = eglGetProcAddress("eglReleaseDeviceANGLE");
  if (!eglCreateDeviceANGLE || !eglReleaseDeviceANGLE) return no("this ANGLE cannot take a device (EGL_ANGLE_device_creation)");
  return 1;
}
/* The D3D11 device the textures and ANGLE share: with video support when the driver gives it (mpv's decoders want it). */
static int make_device(void) {
  create_device_t create = (create_device_t)(void *)GetProcAddress(d3ddll, "D3D11CreateDevice");
  if (!create) return 0;
  const char *w = getenv("NEBULA_GPU_WARP");
  int type = (w && w[0] == '1') ? 5 : 1;               /* D3D_DRIVER_TYPE_WARP : D3D_DRIVER_TYPE_HARDWARE */
  const int levels[] = { 0xb100, 0xb000, 0xa100, 0xa000 };   /* 11_1, 11_0, 10_1, 10_0 */
  const UINT bgra = 0x20, video = 0x800;               /* D3D11_CREATE_DEVICE_BGRA_SUPPORT, _VIDEO_SUPPORT */
  if (SUCCEEDED(create(NULL, type, NULL, bgra | video, levels, 4, 7, &dev, NULL, NULL)) && dev) return 1;
  if (SUCCEEDED(create(NULL, type, NULL, bgra | video, levels + 1, 3, 7, &dev, NULL, NULL)) && dev) return 1;   /* (no 11_1 runtime) */
  dev = NULL;
  return SUCCEEDED(create(NULL, type, NULL, bgra, levels + 1, 3, 7, &dev, NULL, NULL)) && dev;
}
static int make_context(void) {
  void *cfg = NULL; int n = 0;
  const int want[] = { EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_NONE }, attrs[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };
  if (!eglBindAPI(EGL_OPENGL_ES_API)) return 0;
  if (!eglChooseConfig(dpy, want, &cfg, 1, &n) || n < 1) cfg = NULL;
  ctx = eglCreateContext(dpy, cfg, NULL, attrs);
  return ctx && eglMakeCurrent(dpy, NULL, NULL, ctx);  /* no surface at all (EGL_KHR_surfaceless_context) */
}

int gpu_init(void) {
  InitializeCriticalSection(&keptcs);
  if (!load_libs()) return 0;
  int ma = 0, mi = 0;
  if (!make_device()) return no("no Direct3D 11 device");
  edev = eglCreateDeviceANGLE(EGL_D3D11_DEVICE_ANGLE, dev, NULL);
  if (!edev) return no("ANGLE would not take the device");
  dpy = eglGetPlatformDisplay(EGL_PLATFORM_DEVICE_EXT, edev, NULL);
  if (!dpy || !eglInitialize(dpy, &ma, &mi)) return no("no EGL display on the device");
  parent = OpenProcess(PROCESS_DUP_HANDLE, FALSE, (DWORD)nebula_parent_pid);
  if (!parent) return no("the main process cannot be handed textures");
  const char *ext = eglQueryString(dpy, EGL_EXTENSIONS);
  if (!ext || !strstr(ext, "EGL_KHR_surfaceless_context")) return no("no EGL_KHR_surfaceless_context");
  if (!strstr(ext, "EGL_ANGLE_image_d3d11_texture")) return no("no EGL_ANGLE_image_d3d11_texture");
  if (!make_context()) return no("no GL ES 3 context");
  EXT(eglCreateImageKHR); EXT(eglDestroyImageKHR);
  EXT(glGenTextures); EXT(glDeleteTextures); EXT(glBindTexture); EXT(glTexParameteri); EXT(glGenFramebuffers); EXT(glDeleteFramebuffers);
  EXT(glBindFramebuffer); EXT(glFramebufferTexture2D); EXT(glCheckFramebufferStatus); EXT(glEGLImageTargetTexture2DOES);
  EXT(glViewport); EXT(glClearColor); EXT(glClear); EXT(glFinish); EXT(glColorMask); EXT(glDisable); EXT(glReadPixels);
  return 1;
}
void *gpu_proc(void *c, const char *name) {
  (void)c;
  void *f = eglGetProcAddress(name);
  return f ? f : (void *)GetProcAddress(glesdll, name);
}
int gpu_va_fd(void) { return -1; }

/* the handles of one set, in the main process: closed there once it has let go of them (or this set is long gone) */
static void close_theirs(HANDLE *h) {
  for (int i = 0; i < NBUF; i++) {
    if (h[i]) DuplicateHandle(parent, h[i], NULL, NULL, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
    h[i] = NULL;
  }
}
void gpu_drop(uint32_t s) {
  if (!parent) return;                                 /* (never drawing this way: nothing was handed over) */
  { const char *t = getenv("NEBULA_GPU_TRACE"); if (t && t[0] == '1') { fprintf(stderr, "nebula-mpv: trace drop set %u\n", s); fflush(stderr); } }
  EnterCriticalSection(&keptcs);
  for (int k = 0; k < KEEP; k++) if (kept[k].serial == s) { close_theirs(kept[k].h); kept[k].serial = 0; }
  LeaveCriticalSection(&keptcs);
}
static void keep_theirs(void) {
  EnterCriticalSection(&keptcs);
  int slot = -1;
  for (int k = 0; k < KEEP && slot < 0; k++) if (!kept[k].serial) slot = k;
  if (slot < 0) {                                      /* sixteen sets never let go: the oldest cannot be in use any more */
    slot = 0;
    for (int k = 1; k < KEEP; k++) if (kept[k].serial < kept[slot].serial) slot = k;
    close_theirs(kept[slot].h);
  }
  kept[slot].serial = serial;
  for (int i = 0; i < NBUF; i++) { kept[slot].h[i] = buf[i].theirs; buf[i].theirs = NULL; }
  LeaveCriticalSection(&keptcs);
}

static void drop_bufs(void) {
  HANDLE unsent[NBUF] = { 0 };                         /* (a set that was never told: its handles are closed at once) */
  for (int i = 0; i < NBUF; i++) {
    if (buf[i].fbo) glDeleteFramebuffers(1, &buf[i].fbo);
    if (buf[i].gltex) glDeleteTextures(1, &buf[i].gltex);
    if (buf[i].img) eglDestroyImageKHR(dpy, buf[i].img);
    if (buf[i].tex) ID3D11Texture2D_Release(buf[i].tex);
    unsent[i] = buf[i].theirs;
    buf[i].tex = NULL; buf[i].img = NULL; buf[i].gltex = buf[i].fbo = 0; buf[i].theirs = NULL;
  }
  close_theirs(unsent);
}
/* NBUF textures of w x h, each told to the main process. 0 = the driver would not make them (the old ones are gone too). */
int gpu_size(uint32_t w, uint32_t h) {
  drop_bufs();
  bw = bh = 0;
  for (int i = 0; i < NBUF; i++) {
    D3D11_TEXTURE2D_DESC d;
    memset(&d, 0, sizeof d);
    d.Width = w; d.Height = h; d.MipLevels = 1; d.ArraySize = 1; d.Format = DXGI_FORMAT_B8G8R8A8_UNORM; d.SampleDesc.Count = 1;
    d.Usage = D3D11_USAGE_DEFAULT; d.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
    d.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;   /* bgra: no keyed mutex (Electron's rule) */
    HRESULT th = ID3D11Device_CreateTexture2D(dev, &d, NULL, &buf[i].tex);
    if (FAILED(th) || !buf[i].tex) { fprintf(stderr, "nebula-mpv: graphics chip: no shared texture (0x%08lx)\n", (unsigned long)th); drop_bufs(); return 0; }
    IDXGIResource1 *r = NULL;
    HANDLE mine = NULL;
    if (FAILED(ID3D11Texture2D_QueryInterface(buf[i].tex, &IID_IDXGIResource1, (void **)&r)) || !r) { no("no IDXGIResource1"); drop_bufs(); return 0; }
    HRESULT hr = IDXGIResource1_CreateSharedHandle(r, NULL, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, NULL, &mine);
    IDXGIResource1_Release(r);
    if (FAILED(hr) || !mine) { fprintf(stderr, "nebula-mpv: graphics chip: no NT handle (0x%08lx)\n", (unsigned long)hr); drop_bufs(); return 0; }
    BOOL dup = DuplicateHandle(GetCurrentProcess(), mine, parent, &buf[i].theirs, 0, FALSE, DUPLICATE_SAME_ACCESS);
    CloseHandle(mine);
    if (!dup || !buf[i].theirs) { buf[i].theirs = NULL; fprintf(stderr, "nebula-mpv: graphics chip: the handle could not be handed over (%lu)\n", GetLastError()); drop_bufs(); return 0; }
    const int none[] = { EGL_NONE };
    buf[i].img = eglCreateImageKHR(dpy, NULL, EGL_D3D11_TEXTURE_ANGLE, buf[i].tex, none);
    if (!buf[i].img) { no("ANGLE would not take the texture as an image"); drop_bufs(); return 0; }
    glGenTextures(1, &buf[i].gltex); glGenFramebuffers(1, &buf[i].fbo);
    glBindTexture(GL_TEXTURE_2D, buf[i].gltex);
    glTexParameteri(GL_TEXTURE_2D, 0x2801, 0x2601); glTexParameteri(GL_TEXTURE_2D, 0x2800, 0x2601);
    glEGLImageTargetTexture2DOES(GL_TEXTURE_2D, buf[i].img);
    glBindFramebuffer(GL_FRAMEBUFFER, buf[i].fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, 0x8CE0, GL_TEXTURE_2D, buf[i].gltex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != 0x8CD5) { no("the texture cannot be drawn into"); drop_bufs(); return 0; }
  }
  glBindTexture(GL_TEXTURE_2D, 0); glBindFramebuffer(GL_FRAMEBUFFER, 0);
  serial++; bw = w; bh = h; nextbuf = 0;
  for (int i = 0; i < NBUF; i++)
    printf("BUF %u %d %d %u %u %llu %u 0 0\n", serial, i, NBUF, w, h, (unsigned long long)(uintptr_t)buf[i].theirs, w * 4u);
  fflush(stdout);
  keep_theirs();                                       /* (from here the handles are closed when the main process says so) */
  return 1;
}
uint32_t gpu_serial(void) { return serial; }
void gpu_have(uint32_t *w, uint32_t *h) { *w = bw; *h = bh; }
int gpu_next(void) { int i = nextbuf; nextbuf = (nextbuf + 1) % NBUF; return i; }
unsigned gpu_fbo(int i) { return buf[i].fbo; }
/* The frame in texture i is complete: every pixel opaque (the window reads the fourth byte as alpha), and the drawing has
   reached the texture — glFinish waits for the chip, so the window's own device reads a finished picture. */
void gpu_finish(int i) {
  static int traced = -1, every;
  if (traced < 0) { const char *t = getenv("NEBULA_GPU_TRACE"); traced = t && t[0] == '1'; }
  int tr = traced && ++every % 24 == 0;                /* (a test's trace: what this texture holds, read back here) */
  unsigned char a[4] = { 0 }, b[4] = { 0 };
  glBindFramebuffer(GL_FRAMEBUFFER, buf[i].fbo);
  if (tr) glReadPixels((int)bw / 4, (int)bh / 4, 1, 1, 0x1908, 0x1401, a);
  glDisable(0x0C11);                                   /* (scissor) */
  glColorMask(0, 0, 0, 1); glClearColor(0.0f, 0.0f, 0.0f, 1.0f); glClear(0x4000); glColorMask(1, 1, 1, 1);
  if (tr) {
    glReadPixels((int)bw / 4, (int)bh / 4, 1, 1, 0x1908, 0x1401, b);
    fprintf(stderr, "nebula-mpv: trace set %u buffer %d %ux%u drawn %u %u %u %u, after the alpha %u %u %u %u\n", serial, i, bw, bh,
      a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]); fflush(stderr);
  }
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glFinish();
}
/* A grid of the picture in buffer i, read back here, for the main process to hold against mpv's own screenshot of the same
   film (mpv-host.js): "P <serial> <w> <h> <cols> <rows> r g b …", row by row from the picture's top (the buffers' first row
   is the picture's top: RP_FLIP_Y 0). */
void gpu_probe(int i) {
  enum { COLS = 12, ROWS = 8 };
  const char *bk = getenv("NEBULA_GPU_PROBE_BLACK");   /* (a rig's: the check must see a wrong picture and go to software) */
  int black = bk && bk[0] == '1';
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
  if (dpy) {
    drop_bufs();
    eglMakeCurrent(dpy, NULL, NULL, NULL);
    if (ctx) eglDestroyContext(dpy, ctx);
    eglTerminate(dpy);
  }
  if (edev) eglReleaseDeviceANGLE(edev);
  if (dev) ID3D11Device_Release(dev);
  if (parent) {
    EnterCriticalSection(&keptcs);
    for (int k = 0; k < KEEP; k++) { if (kept[k].serial) close_theirs(kept[k].h); kept[k].serial = 0; }
    LeaveCriticalSection(&keptcs);
  }
  dpy = ctx = edev = NULL; dev = NULL;
}
#endif
