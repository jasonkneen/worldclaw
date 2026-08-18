const MAX_INPUT_IMAGES = 6;
const MAX_INPUT_BASE64_CHARS = 12_000_000;
const MAX_INPUT_PIXELS = 16_777_216;
const MAX_OUTPUT_PIXELS = 8_388_608;

export interface InlineImageBytes {
  b64: string;
  mime: "image/png" | "image/jpeg";
}

interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function boundedPanelDimension(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 64 || value > 2_048) {
    throw new Error(`${label} must be an integer from 64 to 2048`);
  }
  return value;
}

async function decodeInlineImage(image: InlineImageBytes, index: number): Promise<DecodedImage> {
  if (!/^[a-z0-9+/=\r\n]+$/i.test(image.b64) || image.b64.length > MAX_INPUT_BASE64_CHARS) {
    throw new Error(`Panel ${index + 1} exceeds the inline image budget`);
  }
  const bytes = Buffer.from(image.b64.replace(/\s+/g, ""), "base64");
  let width: number;
  let height: number;
  let rgba: Uint8Array;
  if (image.mime === "image/png") {
    const { PNG } = await import("pngjs");
    const decoded = PNG.sync.read(bytes);
    width = decoded.width;
    height = decoded.height;
    rgba = new Uint8Array(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length);
  } else if (image.mime === "image/jpeg") {
    const jpeg = await import("jpeg-js");
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    width = decoded.width;
    height = decoded.height;
    rgba = decoded.data as Uint8Array;
  } else {
    throw new Error(`Panel ${index + 1} must be PNG or JPEG`);
  }
  if (width < 2 || height < 2 || width * height > MAX_INPUT_PIXELS) {
    throw new Error(`Panel ${index + 1} has invalid or oversized dimensions`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`Panel ${index + 1} has invalid RGBA data`);
  }
  return { width, height, rgba };
}

function channel(image: DecodedImage, x: number, y: number, offset: number): number {
  return image.rgba[(y * image.width + x) * 4 + offset] ?? 0;
}

function writeCoverResample(
  source: DecodedImage,
  output: Uint8Array,
  outputWidth: number,
  panelX: number,
  panelWidth: number,
  panelHeight: number,
): void {
  const sourceAspect = source.width / source.height;
  const panelAspect = panelWidth / panelHeight;
  const cropWidth = sourceAspect > panelAspect ? source.height * panelAspect : source.width;
  const cropHeight = sourceAspect > panelAspect ? source.height : source.width / panelAspect;
  const cropX = (source.width - cropWidth) * 0.5;
  const cropY = (source.height - cropHeight) * 0.5;

  for (let y = 0; y < panelHeight; y++) {
    const sourceY = cropY + ((y + 0.5) / panelHeight) * cropHeight - 0.5;
    const y0 = Math.max(0, Math.min(source.height - 1, Math.floor(sourceY)));
    const y1 = Math.max(0, Math.min(source.height - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, sourceY - y0));
    for (let x = 0; x < panelWidth; x++) {
      const sourceX = cropX + ((x + 0.5) / panelWidth) * cropWidth - 0.5;
      const x0 = Math.max(0, Math.min(source.width - 1, Math.floor(sourceX)));
      const x1 = Math.max(0, Math.min(source.width - 1, x0 + 1));
      const fx = Math.max(0, Math.min(1, sourceX - x0));
      const destination = (y * outputWidth + panelX + x) * 4;
      for (let component = 0; component < 4; component++) {
        const top =
          channel(source, x0, y0, component) * (1 - fx) + channel(source, x1, y0, component) * fx;
        const bottom =
          channel(source, x0, y1, component) * (1 - fx) + channel(source, x1, y1, component) * fx;
        output[destination + component] = Math.round(top * (1 - fy) + bottom * fy);
      }
    }
  }
}

/**
 * Compose independently generated registered views into deterministic equal
 * panels. Originals remain separate evidence; this strip is the compatibility
 * input for the existing VisualContract/final-judge seams.
 */
export async function composeHorizontalImageStrip(
  images: InlineImageBytes[],
  panelWidth = 512,
  panelHeight = 512,
): Promise<InlineImageBytes & { width: number; height: number }> {
  if (images.length < 2 || images.length > MAX_INPUT_IMAGES) {
    throw new Error(`Image strip requires 2-${MAX_INPUT_IMAGES} panels`);
  }
  const safePanelWidth = boundedPanelDimension(panelWidth, "Panel width");
  const safePanelHeight = boundedPanelDimension(panelHeight, "Panel height");
  const width = safePanelWidth * images.length;
  const height = safePanelHeight;
  if (width * height > MAX_OUTPUT_PIXELS) {
    throw new Error("Image strip exceeds the output pixel budget");
  }
  const decoded = await Promise.all(images.map(decodeInlineImage));
  const rgba = new Uint8Array(width * height * 4);
  for (const [index, image] of decoded.entries()) {
    writeCoverResample(image, rgba, width, index * safePanelWidth, safePanelWidth, safePanelHeight);
  }
  const { PNG } = await import("pngjs");
  const png = new PNG({ width, height });
  png.data.set(rgba);
  return {
    b64: PNG.sync.write(png).toString("base64"),
    mime: "image/png",
    width,
    height,
  };
}

/**
 * Normalize a provider-authored contact sheet into equal ordered square panels.
 * This lets every image model propose all registered views in one bounded call
 * while downstream judges and repair passes still address each view separately.
 */
export async function splitHorizontalImageStrip(
  image: InlineImageBytes,
  panelCount = 3,
  panelSize = 512,
): Promise<Array<InlineImageBytes & { width: number; height: number }>> {
  if (!Number.isInteger(panelCount) || panelCount < 2 || panelCount > MAX_INPUT_IMAGES) {
    throw new Error(`Image strip split requires 2-${MAX_INPUT_IMAGES} panels`);
  }
  const size = boundedPanelDimension(panelSize, "Split panel size");
  const decoded = await decodeInlineImage(image, 0);
  if (decoded.width < panelCount * 32) {
    throw new Error("Image strip is too narrow for the requested panel count");
  }
  const { PNG } = await import("pngjs");
  return Array.from({ length: panelCount }, (_, panelIndex) => {
    const startX = Math.floor((panelIndex * decoded.width) / panelCount);
    const endX = Math.floor(((panelIndex + 1) * decoded.width) / panelCount);
    const cropWidth = Math.max(1, endX - startX);
    const croppedRgba = new Uint8Array(cropWidth * decoded.height * 4);
    for (let y = 0; y < decoded.height; y++) {
      const sourceStart = (y * decoded.width + startX) * 4;
      const sourceEnd = sourceStart + cropWidth * 4;
      croppedRgba.set(decoded.rgba.subarray(sourceStart, sourceEnd), y * cropWidth * 4);
    }
    const output = new Uint8Array(size * size * 4);
    writeCoverResample(
      { width: cropWidth, height: decoded.height, rgba: croppedRgba },
      output,
      size,
      0,
      size,
      size,
    );
    const png = new PNG({ width: size, height: size });
    png.data.set(output);
    return {
      b64: PNG.sync.write(png).toString("base64"),
      mime: "image/png" as const,
      width: size,
      height: size,
    };
  });
}

/**
 * Produce a bounded, aspect-preserving JPEG for the visible evidence ledger.
 * The selected full-resolution image remains on ScenePlan; committee variants
 * use these thumbnails so retaining every model output does not make the world
 * payload unbounded.
 */
export async function createEvidenceThumbnail(
  image: InlineImageBytes,
  maxDimension = 640,
  quality = 82,
): Promise<InlineImageBytes & { width: number; height: number }> {
  const boundedMax = boundedPanelDimension(maxDimension, "Evidence maximum dimension");
  if (!Number.isInteger(quality) || quality < 50 || quality > 95) {
    throw new Error("Evidence JPEG quality must be an integer from 50 to 95");
  }
  const decoded = await decodeInlineImage(image, 0);
  const scale = Math.min(1, boundedMax / Math.max(decoded.width, decoded.height));
  const width = Math.max(64, Math.round(decoded.width * scale));
  const height = Math.max(64, Math.round(decoded.height * scale));
  const rgba = new Uint8Array(width * height * 4);
  writeCoverResample(decoded, rgba, width, 0, width, height);
  const jpeg = await import("jpeg-js");
  return {
    b64: jpeg.encode({ data: rgba, width, height }, quality).data.toString("base64"),
    mime: "image/jpeg",
    width,
    height,
  };
}
