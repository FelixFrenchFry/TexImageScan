// reject constant-color and fully transparent images
export function assertImageHasContent(
  data: Uint8Array | Uint8ClampedArray,
  channels: number,
): void {
  const hasAlpha = channels === 2 || channels === 4;
  let uniform = true;
  let invisible = hasAlpha;
  for (let offset = 0; offset < data.length; offset += channels) {
    if (hasAlpha && data[offset + channels - 1] !== 0) invisible = false;
    for (let channel = 0; channel < channels; channel++) {
      if (data[offset + channel] !== data[channel]) uniform = false;
    }
    if (!uniform && !invisible) return;
  }
  throw new Error('This image appears blank. Choose a crop containing text or an equation.');
}
