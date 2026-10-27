import { resizeBicubicPIL, smartResize } from './vendor/pil-resize.js';
import { assertImageHasContent } from './image';

/** flatten alpha onto white before matching the Python RGB resize */
function compositeRgb(rgba: Uint8ClampedArray, width: number, height: number) {
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const alpha = rgba[pixel * 4 + 3] ?? 0;
    for (let channel = 0; channel < 3; channel++) {
      const value = rgba[pixel * 4 + channel] ?? 0;
      rgb[pixel * 3 + channel] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  assertImageHasContent(rgb, 3);
  return rgb;
}

export function prepareTeleocrPixels(rgba: Uint8ClampedArray, width: number, height: number) {
  const rgb = compositeRgb(rgba, width, height);
  // the vendor helper can round a thin side to zero
  // pad with white instead of shrinking the long side to meet the minimum area
  const paddedWidth = Math.max(28, width);
  const paddedHeight = Math.max(28, height);
  let data = rgb;
  if (paddedWidth !== width || paddedHeight !== height) {
    data = new Uint8ClampedArray(paddedWidth * paddedHeight * 3).fill(255);
    const left = Math.floor((paddedWidth - width) / 2);
    const top = Math.floor((paddedHeight - height) / 2);
    for (let row = 0; row < height; row++) {
      data.set(
        rgb.subarray(row * width * 3, (row + 1) * width * 3),
        ((row + top) * paddedWidth + left) * 3,
      );
    }
  }
  // cap vision attention at about one megapixel
  const [targetHeight, targetWidth] = smartResize(paddedHeight, paddedWidth, 28, 3136, 1_003_520);
  return {
    data: resizeBicubicPIL(data, paddedWidth, paddedHeight, 3, targetWidth, targetHeight),
    width: targetWidth,
    height: targetHeight,
  };
}
