/* takefd.c — nebula-takefd.node, a Node-API addon for the MAIN process (Linux): a copy of a descriptor the helper holds.
 *
 * The helper draws on the graphics chip into dmabufs (gpu.c); Electron imports a dmabuf as a shared texture only from a
 * descriptor in its own process, and Node has no way to be handed one (a dmabuf cannot be reopened through /proc — ENXIO,
 * tried 09-30). pidfd_getfd (Linux 5.6) copies a descriptor out of another process the caller may ptrace — its own child,
 * under the default Yama rule — and that is all this does:
 *   takeFd(pid, fd) → a descriptor here (close-on-exec), or -errno      closeFd(fd) → 0 or -1
 *   sizeFd(fd) → what it holds in bytes (a dmabuf answers; capped at 2 GiB), or -errno
 * The page never reaches it: mpv-gpu.js calls it with the helper's pid and numbers the helper printed.
 * No headers needed: Node-API is a stable C ABI, and the five calls used are declared here (the host program exports them).
 *   gcc -O2 -Wall -Wextra -Werror -shared -fPIC -o nebula-takefd.node helper/takefd.c
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef SYS_pidfd_open
#define SYS_pidfd_open 434
#endif
#ifndef SYS_pidfd_getfd
#define SYS_pidfd_getfd 438
#endif

typedef struct napi_env__ *napi_env;
typedef struct napi_value__ *napi_value;
typedef struct napi_callback_info__ *napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
extern int napi_get_cb_info(napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **);
extern int napi_get_value_int32(napi_env, napi_value, int32_t *);
extern int napi_create_int32(napi_env, int32_t, napi_value *);
extern int napi_create_function(napi_env, const char *, size_t, napi_callback, void *, napi_value *);
extern int napi_set_named_property(napi_env, napi_value, const char *, napi_value);

static int two(napi_env env, napi_callback_info info, int32_t *a, int32_t *b) {
  size_t argc = 2; napi_value argv[2] = { NULL, NULL };
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 1) return 0;
  if (napi_get_value_int32(env, argv[0], a) != 0) return 0;
  if (b && (argc < 2 || napi_get_value_int32(env, argv[1], b) != 0)) return 0;
  return 1;
}
static napi_value num(napi_env env, int32_t v) { napi_value out = NULL; napi_create_int32(env, v, &out); return out; }

static napi_value take(napi_env env, napi_callback_info info) {
  int32_t pid = 0, fd = -1;
  if (!two(env, info, &pid, &fd) || pid <= 1 || fd < 0) return num(env, -EINVAL);
  int p = (int)syscall(SYS_pidfd_open, pid, 0);
  if (p < 0) return num(env, -errno);
  int r = (int)syscall(SYS_pidfd_getfd, p, fd, 0);      /* close-on-exec by definition */
  if (r < 0) r = -errno;
  close(p);
  return num(env, r);
}
static napi_value shut(napi_env env, napi_callback_info info) {
  int32_t fd = -1;
  if (!two(env, info, &fd, NULL) || fd <= 2) return num(env, -1);
  return num(env, close(fd));
}

static napi_value size(napi_env env, napi_callback_info info) {
  int32_t fd = -1;
  if (!two(env, info, &fd, NULL) || fd <= 2) return num(env, -EINVAL);
  off_t n = lseek(fd, 0, SEEK_END);
  if (n < 0) return num(env, -errno);
  lseek(fd, 0, SEEK_SET);
  return num(env, n > 0x7fffffff ? 0x7fffffff : (int32_t)n);
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
  napi_value f = NULL;
  if (napi_create_function(env, "takeFd", (size_t)-1, take, NULL, &f) == 0) napi_set_named_property(env, exports, "takeFd", f);
  if (napi_create_function(env, "closeFd", (size_t)-1, shut, NULL, &f) == 0) napi_set_named_property(env, exports, "closeFd", f);
  if (napi_create_function(env, "sizeFd", (size_t)-1, size, NULL, &f) == 0) napi_set_named_property(env, exports, "sizeFd", f);
  return exports;
}
