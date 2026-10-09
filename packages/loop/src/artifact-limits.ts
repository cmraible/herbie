// Bound untrusted transport before parsing/base64 decoding, then validate decoded sizes.
export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = Math.ceil(MAX_PATCH_BYTES / 3) * 4 + 1024;
export const MAX_TEST_OUTPUT_BYTES = 1024 * 1024;
// JSON can expand each output byte to a six-byte escape (for example, \u0000).
export const MAX_TEST_RESULT_BYTES = MAX_TEST_OUTPUT_BYTES * 2 * 6 + 1024;
