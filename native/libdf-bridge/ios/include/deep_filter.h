#pragma once

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct DFState DFState;

DFState *df_create(const char *path, float atten_lim, const char *log_level);
size_t df_get_frame_length(DFState *st);
void df_reset(DFState *st);
float df_process_frame(DFState *st, float *input, float *output);
void df_free(DFState *model);

#ifdef __cplusplus
}
#endif
