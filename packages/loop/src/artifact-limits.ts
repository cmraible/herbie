// Bound untrusted transport before parsing/base64 decoding, then validate decoded sizes.
export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = Math.ceil(MAX_PATCH_BYTES / 3) * 4 + 1024;
