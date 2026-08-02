import { afterEach, describe, expect, it, vi } from "vitest";

interface VideoDecoderSupportModule {
  probeVideoDecoderSupport(
    config: Readonly<VideoDecoderConfig>
  ): Promise<boolean>;
}

const moduleUrl = new URL(
  "../../examples/grass-rabbit-codecs/video-decoder-support.js",
  import.meta.url
).href;
const { probeVideoDecoderSupport } = await import(
  moduleUrl
) as VideoDecoderSupportModule;

const CONFIG = Object.freeze({
  codec: "avc1.640028",
  codedWidth: 1280,
  codedHeight: 720
}) satisfies Readonly<VideoDecoderConfig>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("grass rabbit codec support probe", () => {
  it("returns false when the WebCodecs support boundary is unavailable", async () => {
    vi.stubGlobal("VideoDecoder", undefined);
    await expect(probeVideoDecoderSupport(CONFIG)).resolves.toBe(false);

    vi.stubGlobal("VideoDecoder", function VideoDecoderWithoutProbe() {});
    await expect(probeVideoDecoderSupport(CONFIG)).resolves.toBe(false);
  });

  it("passes the exact decoder configuration to the platform", async () => {
    const isConfigSupported = vi.fn(async () => ({ supported: true }));
    vi.stubGlobal(
      "VideoDecoder",
      Object.assign(function TestVideoDecoder() {}, { isConfigSupported })
    );

    await expect(probeVideoDecoderSupport(CONFIG)).resolves.toBe(true);
    expect(isConfigSupported).toHaveBeenCalledOnce();
    expect(isConfigSupported).toHaveBeenCalledWith(CONFIG);
  });

  it.each([
    Object.freeze({ supported: false }),
    Object.freeze({ supported: undefined }),
    Object.freeze({})
  ])("returns true only for an exact supported result %#", async (result) => {
    const isConfigSupported = vi.fn(async () => result);
    vi.stubGlobal(
      "VideoDecoder",
      Object.assign(function TestVideoDecoder() {}, { isConfigSupported })
    );

    await expect(probeVideoDecoderSupport(CONFIG)).resolves.toBe(false);
  });

  it("propagates platform rejection to the sequential controller", async () => {
    const failure = new Error("support probe failed");
    const isConfigSupported = vi.fn(async () => Promise.reject(failure));
    vi.stubGlobal(
      "VideoDecoder",
      Object.assign(function TestVideoDecoder() {}, { isConfigSupported })
    );

    await expect(probeVideoDecoderSupport(CONFIG)).rejects.toBe(failure);
  });
});
