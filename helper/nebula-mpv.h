/* nebula-mpv.h — what the helper's two halves share: nebula-mpv.c draws the frames, frames.c serves them to the page. */
#ifndef NEBULA_MPV_H
#define NEBULA_MPV_H
#ifdef _WIN32
#include <winsock2.h>
#include <windows.h>
#endif
#include <stddef.h>
#include <stdint.h>

/* One frame buffer. The drawing fills a slot nobody is sending (readers == 0) that is not the newest, then publishes it. */
typedef struct { uint8_t *px; uint32_t w, h, stride, drawus, gen, readers; uint64_t count; } slot_t;

int frames_init(uint32_t maxw, uint32_t maxh, const char *token, const char *origin);   /* the port it listens on, 0 = failed */
slot_t *frames_acquire(void);                          /* a slot to draw into, or NULL when every one is in use */
void frames_publish(slot_t *s);                        /* the finished frame becomes the newest; waiting requests wake */
void frames_want(uint32_t *w, uint32_t *h, int *pad);  /* the size (and row padding) the page asked for last */
int frames_idle(void);                                 /* 1 when the page has not asked for a frame in 1.5 s */
#endif
