export async function probeVideoDecoderSupport(config) {
  const decoder = globalThis.VideoDecoder;
  if (
    typeof decoder !== "function" ||
    typeof decoder.isConfigSupported !== "function"
  ) return false;
  const result = await decoder.isConfigSupported(config);
  return result.supported === true;
}
