/*
 * WebAssembly SIMD kernels for brute-force top-K inner-product scan.
 * Build: see build-wasm.sh (clang --target=wasm32 -msimd128). The module imports its memory so the
 * host (a Bun Worker) can size it for the vector matrix and fill it with blobs read from SQLite.
 *
 * Vectors are L2-normalised before quantisation, so inner product == cosine.
 *   int8 layout   : vecs[n][dim] int8, scales[n] float; score = dot(q, v) * qscale * scales[i]
 *   float32 layout: vecs[n][dim] float
 */
#include <stdint.h>
#include <wasm_simd128.h>

#define EXPORT __attribute__((visibility("default")))

static int g_k, g_n;
static float *g_s;
static int32_t *g_i;
static float g_thr;

EXPORT void topk_reset(float *scores, int32_t *ids, int k) {
	g_k = k;
	g_n = 0;
	g_s = scores;
	g_i = ids;
	g_thr = -3.4e38f;
}

EXPORT int topk_count(void) { return g_n; }

static inline void push(float s, int32_t id) {
	if (g_n < g_k) {
		int j = g_n++;
		while (j > 0 && g_s[j - 1] < s) {
			g_s[j] = g_s[j - 1];
			g_i[j] = g_i[j - 1];
			j--;
		}
		g_s[j] = s;
		g_i[j] = id;
		if (g_n == g_k) g_thr = g_s[g_k - 1];
	} else if (s > g_thr) {
		int j = g_k - 1;
		while (j > 0 && g_s[j - 1] < s) {
			g_s[j] = g_s[j - 1];
			g_i[j] = g_i[j - 1];
			j--;
		}
		g_s[j] = s;
		g_i[j] = id;
		g_thr = g_s[g_k - 1];
	}
}

static inline int32_t dot_i8(const int8_t *a, const int8_t *b, uint32_t n) {
	v128_t acc0 = wasm_i32x4_splat(0);
	v128_t acc1 = wasm_i32x4_splat(0);
	for (uint32_t i = 0; i < n; i += 32) {
		v128_t x0 = wasm_v128_load(a + i);
		v128_t y0 = wasm_v128_load(b + i);
		v128_t x1 = wasm_v128_load(a + i + 16);
		v128_t y1 = wasm_v128_load(b + i + 16);
		acc0 = wasm_i32x4_add(acc0, wasm_i32x4_extadd_pairwise_i16x8(wasm_i16x8_extmul_low_i8x16(x0, y0)));
		acc1 = wasm_i32x4_add(acc1, wasm_i32x4_extadd_pairwise_i16x8(wasm_i16x8_extmul_high_i8x16(x0, y0)));
		acc0 = wasm_i32x4_add(acc0, wasm_i32x4_extadd_pairwise_i16x8(wasm_i16x8_extmul_low_i8x16(x1, y1)));
		acc1 = wasm_i32x4_add(acc1, wasm_i32x4_extadd_pairwise_i16x8(wasm_i16x8_extmul_high_i8x16(x1, y1)));
	}
	v128_t acc = wasm_i32x4_add(acc0, acc1);
	return wasm_i32x4_extract_lane(acc, 0) + wasm_i32x4_extract_lane(acc, 1) +
	       wasm_i32x4_extract_lane(acc, 2) + wasm_i32x4_extract_lane(acc, 3);
}

static inline float dot_f32(const float *a, const float *b, uint32_t n) {
	v128_t acc0 = wasm_f32x4_splat(0);
	v128_t acc1 = wasm_f32x4_splat(0);
	v128_t acc2 = wasm_f32x4_splat(0);
	v128_t acc3 = wasm_f32x4_splat(0);
	for (uint32_t i = 0; i < n; i += 16) {
		acc0 = wasm_f32x4_add(acc0, wasm_f32x4_mul(wasm_v128_load(a + i), wasm_v128_load(b + i)));
		acc1 = wasm_f32x4_add(acc1, wasm_f32x4_mul(wasm_v128_load(a + i + 4), wasm_v128_load(b + i + 4)));
		acc2 = wasm_f32x4_add(acc2, wasm_f32x4_mul(wasm_v128_load(a + i + 8), wasm_v128_load(b + i + 8)));
		acc3 = wasm_f32x4_add(acc3, wasm_f32x4_mul(wasm_v128_load(a + i + 12), wasm_v128_load(b + i + 12)));
	}
	v128_t acc = wasm_f32x4_add(wasm_f32x4_add(acc0, acc1), wasm_f32x4_add(acc2, acc3));
	return wasm_f32x4_extract_lane(acc, 0) + wasm_f32x4_extract_lane(acc, 1) +
	       wasm_f32x4_extract_lane(acc, 2) + wasm_f32x4_extract_lane(acc, 3);
}

/* contiguous range [start, end) */
EXPORT void scan_i8_range(const int8_t *vecs, const float *scales, uint32_t start, uint32_t end,
                          uint32_t dim, const int8_t *q, float qscale) {
	for (uint32_t i = start; i < end; i++) {
		float s = (float)dot_i8(q, vecs + (uint64_t)i * dim, dim) * qscale * scales[i];
		if (s > g_thr || g_n < g_k) push(s, (int32_t)i);
	}
}

/* whole range, but only vectors whose space tag equals `want` */
EXPORT void scan_i8_tag(const int8_t *vecs, const float *scales, const uint32_t *space, uint32_t want,
                        uint32_t start, uint32_t end, uint32_t dim, const int8_t *q, float qscale) {
	for (uint32_t i = start; i < end; i++) {
		if (space[i] != want) continue;
		float s = (float)dot_i8(q, vecs + (uint64_t)i * dim, dim) * qscale * scales[i];
		if (s > g_thr || g_n < g_k) push(s, (int32_t)i);
	}
}

/* explicit candidate list (ids resolved by SQL / ACL code) */
EXPORT void scan_i8_ids(const int8_t *vecs, const float *scales, const uint32_t *ids, uint32_t n_ids,
                        uint32_t dim, const int8_t *q, float qscale) {
	for (uint32_t j = 0; j < n_ids; j++) {
		uint32_t i = ids[j];
		float s = (float)dot_i8(q, vecs + (uint64_t)i * dim, dim) * qscale * scales[i];
		if (s > g_thr || g_n < g_k) push(s, (int32_t)i);
	}
}

EXPORT void scan_f32_range(const float *vecs, uint32_t start, uint32_t end, uint32_t dim, const float *q) {
	for (uint32_t i = start; i < end; i++) {
		float s = dot_f32(q, vecs + (uint64_t)i * dim, dim);
		if (s > g_thr || g_n < g_k) push(s, (int32_t)i);
	}
}

EXPORT void scan_f32_tag(const float *vecs, const uint32_t *space, uint32_t want, uint32_t start,
                         uint32_t end, uint32_t dim, const float *q) {
	for (uint32_t i = start; i < end; i++) {
		if (space[i] != want) continue;
		float s = dot_f32(q, vecs + (uint64_t)i * dim, dim);
		if (s > g_thr || g_n < g_k) push(s, (int32_t)i);
	}
}

EXPORT void scan_f32_ids(const float *vecs, const uint32_t *ids, uint32_t n_ids, uint32_t dim, const float *q) {
	for (uint32_t j = 0; j < n_ids; j++) {
		uint32_t i = ids[j];
		float s = dot_f32(q, vecs + (uint64_t)i * dim, dim);
		if (s > g_thr || g_n < g_k) push(s, (int32_t)i);
	}
}
