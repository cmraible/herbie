// Bound untrusted transport before parsing/base64 decoding, then validate decoded sizes.
export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
// Allow room for the description, including JSON escaping.
export const MAX_ARTIFACT_BYTES = Math.ceil(MAX_PATCH_BYTES / 3) * 4 + 512 * 1024;
