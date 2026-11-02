/** The home device's own camera, in the browser showing MERLIN. It opens only when the server asks, which takes a yes, and closes after one frame. */
// A browser can list a doorbell or network feed as an ordinary camera through a bridge or virtual driver.
// Those are home cameras, and virtual cameras can carry anything, so none of them are used to look.
export const HOME_CAMERA_LABEL = /\b(?:ring|doorbells?|nest|arlo|blink|wyze|eufy|reolink|unifi|hikvision|dahua|amcrest|lorex|swann|simplisafe|security|surveillance|cctv|ip ?cam(?:era)?|rtsp|onvif|baby ?monitor|nanny|obs|virtual|manycam|snap camera|droidcam|epoccam)\b/iu;
const MAX_SIDE = 1280;
const failure = code => Object.assign(new Error(code), { code });
const stopAll = stream => { for (const track of stream?.getTracks?.() ?? []) track.stop(); };
const isHomeStream = stream => (stream.getVideoTracks?.() ?? []).some(track => HOME_CAMERA_LABEL.test(track.label || ''));
// Width only: asking for a height too makes Chrome crop a portrait camera, which cuts off heads and shoes.
const constraints = deviceId => ({ audio: false, video: { ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }), width: { ideal: MAX_SIDE } } });

/** Checks without opening anything or prompting. Before permission a browser hides labels, so opening checks again. */
export async function checkDeviceCamera(media) {
  if (!media?.enumerateDevices || !media?.getUserMedia) return { state: 'unsupported', count: 0 };
  try {
    const count = (await media.enumerateDevices()).filter(device => device.kind === 'videoinput' && !HOME_CAMERA_LABEL.test(device.label || '')).length;
    return { state: count ? 'available' : 'none', count };
  } catch { return { state: 'unsupported', count: 0 }; }
}

export function cameraErrorCode(error) {
  if (error?.code && typeof error.code === 'string') return error.code;
  if (['NotAllowedError', 'SecurityError'].includes(error?.name)) return 'denied';
  if (['NotFoundError', 'OverconstrainedError'].includes(error?.name)) return 'none';
  if (['NotReadableError', 'AbortError'].includes(error?.name)) return 'busy';
  return 'failed';
}

async function openCamera(media) {
  if (!media?.getUserMedia) throw failure('none');
  const first = await media.getUserMedia(constraints());
  if (!isHomeStream(first)) return first;
  stopAll(first);
  // Labels are readable now that permission exists, so look for a camera that really belongs to this device.
  const own = (await media.enumerateDevices()).find(device => device.kind === 'videoinput' && device.deviceId && !HOME_CAMERA_LABEL.test(device.label || ''));
  if (!own) throw failure('home_only');
  const second = await media.getUserMedia(constraints(own.deviceId));
  if (isHomeStream(second)) { stopAll(second); throw failure('home_only'); }
  return second;
}

function grabFrame(video, canvas) {
  const { videoWidth: width, videoHeight: height } = video;
  if (!width || !height) throw failure('failed');
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(failure('cancelled')); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(failure('cancelled')); }, { once: true });
});

/** Opens the camera, counts down so the person can get into frame, takes one frame, and always closes the camera. */
export async function captureFrame({ media, video, canvas, signal, seconds = 3, onLive = () => {}, onCountdown = () => {}, wait = pause }) {
  if (signal?.aborted) throw failure('cancelled');
  const stream = await openCamera(media);
  try {
    if (signal?.aborted) throw failure('cancelled');
    video.srcObject = stream;
    await video.play();
    onLive();
    for (let left = seconds; left > 0; left--) { onCountdown(left); await wait(1000, signal); }
    return grabFrame(video, canvas);
  } finally {
    stopAll(stream);
    video.pause?.();
    video.srcObject = null;
  }
}

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const PALE = '#b4e8fb', CYAN = '#8bd9f2', DARK = '#12334b';
/**
 * Paints the camera face's viewfinder: the feed, what SAM 3.1 found, and the authored corner brackets. It is a wide
 * band, so a picture is fitted whole with dark sides rather than cropped: the person sees exactly what MERLIN gets.
 */
export function paintViewfinder(context, width, height, { source, segments = [], count = 0, note = '', scanning = false, seconds = 0 } = {}) {
  context.fillStyle = '#0a2433';
  context.fillRect(0, 0, width, height);
  const sourceWidth = source?.videoWidth || source?.width || 0, sourceHeight = source?.videoHeight || source?.height || 0;
  if (sourceWidth && sourceHeight) {
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const picture = { width: sourceWidth * scale, height: sourceHeight * scale };
    picture.left = (width - picture.width) / 2; picture.top = (height - picture.height) / 2;
    context.drawImage(source, picture.left, picture.top, picture.width, picture.height);
    const boxes = segments.map(({ label, x1, y1, x2, y2, width: frameWidth, height: frameHeight }) => ({ label: String(label).slice(0, 40),
      left: picture.left + x1 * (picture.width / frameWidth), top: picture.top + y1 * (picture.height / frameHeight),
      width: (x2 - x1 + 1) * (picture.width / frameWidth), height: (y2 - y1 + 1) * (picture.height / frameHeight) })).sort((one, other) => one.top - other.top);
    context.lineWidth = Math.max(2, height * 0.012);
    context.strokeStyle = CYAN;
    for (const box of boxes) context.strokeRect(box.left, box.top, box.width, box.height);
    // One tag per kind of thing, stacked in the room beside the picture.
    const size = Math.round(height * 0.085), gap = size * 1.75;
    context.font = `600 ${size}px ${FONT}`;
    let nextTop = height * 0.08;
    for (const box of boxes.filter((item, index) => boxes.findIndex(other => other.label === item.label) === index)) {
      const tagWidth = context.measureText(box.label).width + size, beside = picture.left + picture.width + size * 0.5;
      const tagLeft = beside + tagWidth <= width ? beside : Math.max(0, box.left), tagTop = Math.min(height - gap, Math.max(nextTop, box.top));
      context.fillStyle = PALE;
      context.fillRect(tagLeft, tagTop, tagWidth, size * 1.5);
      context.fillStyle = DARK;
      context.fillText(box.label, tagLeft + size / 2, tagTop + size * 1.08);
      nextTop = tagTop + gap;
    }
    if (scanning) {
      const line = picture.top + ((Math.sin(seconds * 2.4) + 1) / 2) * picture.height;
      context.fillStyle = PALE;
      context.fillRect(picture.left, line - height * 0.006, picture.width, height * 0.012);
    }
  }
  const inset = height * 0.06, arm = height * 0.14;
  context.strokeStyle = PALE;
  context.lineWidth = Math.max(3, height * 0.018);
  context.beginPath();
  for (const [x, y, across, down] of [[inset, inset, 1, 1], [width - inset, inset, -1, 1], [inset, height - inset, 1, -1], [width - inset, height - inset, -1, -1]]) {
    context.moveTo(x + across * arm, y); context.lineTo(x, y); context.lineTo(x, y + down * arm);
  }
  context.stroke();
  context.textAlign = 'center';
  context.fillStyle = PALE;
  if (note) { context.font = `500 ${Math.round(height * 0.1)}px ${FONT}`; context.fillText(note, width / 2, height * 0.54); }
  if (count) { context.font = `600 ${Math.round(height * 0.42)}px ${FONT}`; context.fillText(String(count), width * 0.88, height * 0.65); }
  context.textAlign = 'start';
}
