import { runtimeApi } from './browserApi.js';
import { ExtensionSettings } from './settings.js';
import { getStatusText } from './statusText.js';

// The toolbar action, which Chrome calls action and Firefox's Manifest V2 calls browserAction.
export interface ToolbarAction {
  setIcon(details: { imageData: Record<string, ImageData> } | { path: Record<string, string> }): unknown;
  setTitle(details: { title: string }): unknown;
}

const ICON_SIZES = [16, 32] as const;
let greyIcons: Promise<Record<string, ImageData>> | null = null;

// Shows at a glance whether overrides are on: the full-colour icon when on, a faded grey one when off
// or paused. The tooltip spells the state out, and is set after the icon so it only changes once the
// icon has. Per-tab badges (blocked calls) are untouched.
export async function showOverridesState(action: ToolbarAction, settings: ExtensionSettings): Promise<void> {
  if (settings.enabled) {
    // Root-relative: Chrome resolves relative icon paths against the service worker's own folder.
    await action.setIcon({ path: Object.fromEntries(ICON_SIZES.map((size) => [String(size), `/assets/icon-${size}.png`])) });
  } else {
    greyIcons ??= createGreyIcons();
    await action.setIcon({ imageData: await greyIcons });
  }
  await action.setTitle({ title: `CORS Unblocker: ${getStatusText(settings)}` });
}

async function createGreyIcons(): Promise<Record<string, ImageData>> {
  const entries = await Promise.all(ICON_SIZES.map(async (size) => {
    const response = await fetch(runtimeApi.runtime.getURL(`assets/icon-${size}.png`));
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('2D canvas unavailable');
    }
    context.drawImage(bitmap, 0, 0, size, size);
    const image = context.getImageData(0, 0, size, size);
    for (let index = 0; index < image.data.length; index += 4) {
      const luminance = 0.299 * (image.data[index] ?? 0) + 0.587 * (image.data[index + 1] ?? 0) + 0.114 * (image.data[index + 2] ?? 0);
      image.data[index] = luminance;
      image.data[index + 1] = luminance;
      image.data[index + 2] = luminance;
      image.data[index + 3] = Math.round((image.data[index + 3] ?? 0) * 0.55);
    }
    return [String(size), image] as const;
  }));
  return Object.fromEntries(entries);
}
