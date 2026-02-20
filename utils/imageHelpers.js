const { Jimp } = require('jimp');

const MAX_WIDTH = 800;
const MAX_HEIGHT = 800;
const JPEG_QUALITY = 55; // 0-100; keep under ~500kb for Kora's body limit

/**
 * Resize and compress a base64 image so Kora's API doesn't return 413.
 * Returns base64 string (without data URL prefix). On error returns original.
 */
async function compressBase64Image(base64String) {
  if (!base64String || typeof base64String !== 'string') return base64String;
  const b64 = base64String.trim().replace(/^data:image\/\w+;base64,/, '');
  if (b64.length < 5000) return b64; // already tiny

  try {
    const buffer = Buffer.from(b64, 'base64');
    const image = await Jimp.read(buffer);
    const w = image.bitmap.width;
    const h = image.bitmap.height;
    if (w <= MAX_WIDTH && h <= MAX_HEIGHT && b64.length < 350000) return b64; // ~260kb, skip

    image.contain({ w: MAX_WIDTH, h: MAX_HEIGHT });
    const out = await image.getBuffer('image/jpeg', { quality: JPEG_QUALITY });
    return out.toString('base64');
  } catch (err) {
    console.warn('Image compress failed, using original:', err.message);
    return b64;
  }
}

module.exports = { compressBase64Image };
