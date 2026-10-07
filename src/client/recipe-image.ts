const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_PIXELS = 50_000_000;
const MAX_SOURCE_EDGE = 16_384;
const MAX_PREPARED_EDGE = 2560;
const supportedTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);

export type PreparedRecipePhoto = { blob: Blob; width: number; height: number; name: string };

const unreadable = () => new Error('This photo could not be opened. Choose another JPG, PNG, or WebP image.');
const tooLarge = () => new Error('This photo is too large to open safely. Choose a lower-resolution copy or a closer photo of the recipe.');

function dimensions(bytes: Uint8Array, type: string): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, count: number) => String.fromCharCode(...bytes.subarray(offset, offset + count));
  if (type === 'image/png') {
    if (bytes.length < 33 || ascii(0, 8) !== '\x89PNG\r\n\x1a\n' || ascii(12, 4) !== 'IHDR' || view.getUint32(8) !== 13) throw unreadable();
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (type === 'image/jpeg') {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw unreadable();
    let offset = 2;
    for (let segments = 0; segments < 1024 && offset + 3 < bytes.length; segments++) {
      if (bytes[offset++] !== 0xff) throw unreadable();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9 || marker === undefined || offset + 2 > bytes.length) throw unreadable();
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw unreadable();
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) throw unreadable();
        return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3) };
      }
      offset += length;
    }
    throw unreadable();
  }
  if (bytes.length < 30 || ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP' || view.getUint32(4, true) + 8 > bytes.length) throw unreadable();
  const chunk = ascii(12, 4);
  const chunkLength = view.getUint32(16, true);
  if (chunkLength + 20 > bytes.length) throw unreadable();
  if (chunk === 'VP8X' && chunkLength >= 10) {
    if (bytes[20] & 0x02) throw new Error('Choose a still photo rather than an animated image.');
    return { width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16), height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16) };
  }
  if (chunk === 'VP8 ' && chunkLength >= 10 && ascii(23, 3) === '\x9d\x01\x2a') return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
  if (chunk === 'VP8L' && chunkLength >= 5 && bytes[20] === 0x2f) {
    const bits = view.getUint32(21, true);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  throw unreadable();
}

function validateDimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw unreadable();
  if (width > MAX_SOURCE_EDGE || height > MAX_SOURCE_EDGE || width * height > MAX_SOURCE_PIXELS) throw tooLarge();
}

async function decodePhoto(file: File, signal: AbortSignal): Promise<{ image: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      // The decoder applies EXIF orientation. Drawing the result normalizes it;
      // never apply an additional rotation from metadata.
      const bitmap = await new Promise<ImageBitmap>((resolve, reject) => {
        let settled = false;
        const cleanup = () => { settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => { cleanup(); reject(unreadable()); }, 15_000);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        try {
          void createImageBitmap(file, { imageOrientation: 'from-image' }).then(bitmap => {
            if (settled) { bitmap.close(); return; }
            cleanup(); resolve(bitmap);
          }, error => { if (!settled) { cleanup(); reject(error); } });
        } catch (error) { cleanup(); reject(error); }
      });
      if (signal.aborted) { bitmap.close(); signal.throwIfAborted(); }
      return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
    } catch (error) { if (signal.aborted) throw error; }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); image.onload = null; image.onerror = null; };
      const abort = () => { cleanup(); image.src = ''; reject(signal.reason); };
      const timer = setTimeout(() => { cleanup(); image.src = ''; reject(unreadable()); }, 15_000);
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(unreadable()); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      image.src = url;
    });
    signal.throwIfAborted();
    // Modern HTML image decoding also respects EXIF orientation.
    return { image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ''; URL.revokeObjectURL(url); } };
  } catch (error) { image.src = ''; URL.revokeObjectURL(url); throw error; }
}

function encode(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(unreadable()), 'image/jpeg', quality));
}

/** Prepares only a user-selected photo, entirely in the browser. No network calls. */
export async function prepareRecipePhoto(file: File, signal: AbortSignal): Promise<PreparedRecipePhoto> {
  signal.throwIfAborted();
  if (!supportedTypes.has(file.type)) throw new Error('Choose a JPG, PNG, or WebP photo. For HEIC photos, save or share a JPEG copy first.');
  if (!file.size) throw unreadable();
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose a photo under 25 MB. A lower-resolution copy will work well for a clear recipe photo.');
  // Inspect bounded file bytes before allowing any pixel allocation by a decoder.
  const header = dimensions(new Uint8Array(await file.arrayBuffer()), file.type);
  signal.throwIfAborted();
  validateDimensions(header.width, header.height);
  const decoded = await decodePhoto(file, signal);
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    validateDimensions(decoded.width, decoded.height);
    const scale = Math.min(1, MAX_PREPARED_EDGE / Math.max(decoded.width, decoded.height));
    canvas.width = Math.max(1, Math.round(decoded.width * scale));
    canvas.height = Math.max(1, Math.round(decoded.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('This browser could not prepare the photo. Try another browser or paste the recipe text.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(decoded.image, 0, 0, canvas.width, canvas.height);
    // JPEG encoding normalizes orientation and removes source EXIF/GPS metadata.
    // Keep the text at full prepared resolution while reducing quality only as needed.
    for (const quality of [0.92, 0.86, 0.8, 0.72]) {
      signal.throwIfAborted();
      const blob = await encode(canvas, quality);
      signal.throwIfAborted();
      if (blob.type === 'image/jpeg' && blob.size <= MAX_UPLOAD_BYTES) return { blob, width: canvas.width, height: canvas.height, name: file.name };
    }
    throw new Error('This photo is still too large to import clearly. Crop it to the recipe or choose a closer photo.');
  } finally { decoded.close(); canvas.width = 0; canvas.height = 0; }
}

export function recipePhotoBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(unreadable());
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.readAsDataURL(blob);
  });
}
