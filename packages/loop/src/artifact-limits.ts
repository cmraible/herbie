// Bound untrusted transport before parsing/base64 decoding, then validate decoded sizes.
export const MAX_PATCH_BYTES = 8 * 1024 * 1024;
// The transitional artifact carries both a patch and portable file bytes in base64.
// Leave room for both encodings, metadata, and the pull request description.
export const MAX_ARTIFACT_BYTES = Math.ceil(MAX_PATCH_BYTES / 3) * 8 + 512 * 1024;
