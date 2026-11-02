import assert from 'node:assert/strict';
import test from 'node:test';
import { HOME_CAMERA_LABEL, cameraErrorCode, captureFrame, checkDeviceCamera, paintViewfinder } from '../public/companion/device-camera.js';
import { Orchestrator, presentationLayout } from '../public/companion/orchestrator.js';

const named = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });
function fakeMedia({ devices = [{ kind: 'videoinput', deviceId: 'own', label: 'FaceTime HD Camera' }], labels = ['FaceTime HD Camera'], failure } = {}) {
  const opens = [];
  let index = 0;
  return { opens,
    enumerateDevices: async () => devices,
    getUserMedia: async constraints => {
      if (failure) throw failure;
      const track = { kind: 'video', label: labels[Math.min(index++, labels.length - 1)], stopped: false, stop() { this.stopped = true; } };
      const stream = { track, getTracks: () => [track], getVideoTracks: () => [track] };
      opens.push({ constraints, stream });
      return stream;
    } };
}
const fakeVideo = (width = 1920, height = 1080) => ({ videoWidth: width, videoHeight: height, plays: 0, srcObject: null, async play() { this.plays++; }, pause() { this.paused = true; } });
function fakeCanvas() {
  const drawn = [];
  return { width: 0, height: 0, drawn, getContext: () => ({ drawImage: (...args) => drawn.push(args) }), toDataURL: (type, quality) => `data:${type};q=${quality}` };
}
const instant = async () => {};

test('checking for a camera never opens one', async () => {
  const media = fakeMedia();
  assert.deepEqual(await checkDeviceCamera(media), { state: 'available', count: 1 });
  assert.equal(media.opens.length, 0);
});

test('no camera, no API, or a failed check are each reported honestly', async () => {
  assert.deepEqual(await checkDeviceCamera(fakeMedia({ devices: [{ kind: 'audioinput', label: 'Mic' }] })), { state: 'none', count: 0 });
  assert.deepEqual(await checkDeviceCamera(undefined), { state: 'unsupported', count: 0 });
  assert.deepEqual(await checkDeviceCamera({ enumerateDevices: async () => { throw new Error('x'); }, getUserMedia() {} }), { state: 'unsupported', count: 0 });
});

test('before permission a browser hides labels, and a nameless camera still counts until opening checks it', async () => {
  assert.deepEqual(await checkDeviceCamera(fakeMedia({ devices: [{ kind: 'videoinput', deviceId: '', label: '' }] })), { state: 'available', count: 1 });
});

test('doorbells, network feeds and virtual cameras are not this device\'s camera', async () => {
  for (const label of ['Ring Doorbell', 'Ring Video Doorbell Pro', 'Nest Cam', 'Arlo Pro 4', 'Wyze Cam v3', 'Reolink E1', 'Front Door IP Camera', 'RTSP Bridge', 'ONVIF Source', 'OBS Virtual Camera', 'Security Camera', 'Baby Monitor', 'DroidCam', 'ManyCam Virtual Webcam']) {
    assert.match(label, HOME_CAMERA_LABEL, label);
    assert.deepEqual(await checkDeviceCamera(fakeMedia({ devices: [{ kind: 'videoinput', deviceId: 'x', label }] })), { state: 'none', count: 0 }, label);
  }
  for (const label of ['FaceTime HD Camera', 'FaceTime HD Camera (Built-in)', 'iPad Front Camera', 'Logitech BRIO', 'Integrated Webcam', 'USB2.0 HD UVC WebCam', 'fake_device_0', 'Spring Web Camera']) assert.doesNotMatch(label, HOME_CAMERA_LABEL, label);
});

test('one frame, video only, and the camera is off again every time', async () => {
  const media = fakeMedia(), video = fakeVideo(), canvas = fakeCanvas(), counts = [];
  let live = 0;
  const image = await captureFrame({ media, video, canvas, wait: instant, onLive: () => { live++; }, onCountdown: left => counts.push(left) });
  assert.equal(image, 'data:image/jpeg;q=0.85');
  assert.equal(live, 1);
  assert.deepEqual(counts, [3, 2, 1]);
  assert.equal(media.opens.length, 1);
  assert.equal(media.opens[0].constraints.audio, false);
  assert.equal(media.opens[0].stream.track.stopped, true);
  assert.equal(video.srcObject, null);
  assert.equal(canvas.drawn.length, 1);
});

test('the request does not ask for a height, because Chrome crops a portrait camera to fit one', async () => {
  const media = fakeMedia();
  await captureFrame({ media, video: fakeVideo(), canvas: fakeCanvas(), wait: instant });
  assert.deepEqual(Object.keys(media.opens[0].constraints.video).sort(), ['facingMode', 'width']);
});

test('frames keep their shape and stay a sensible size', async () => {
  for (const [width, height, expected] of [[1920, 1080, [1280, 720]], [1080, 1920, [720, 1280]], [640, 480, [640, 480]], [682, 1024, [682, 1024]]]) {
    const canvas = fakeCanvas();
    await captureFrame({ media: fakeMedia(), video: fakeVideo(width, height), canvas, wait: instant });
    assert.deepEqual([canvas.width, canvas.height], expected);
  }
});

test('a home camera handed over as the default is closed at once, for one that belongs to the device', async () => {
  const media = fakeMedia({ labels: ['Ring Doorbell', 'FaceTime HD Camera'], devices: [{ kind: 'videoinput', deviceId: 'ring', label: 'Ring Doorbell' }, { kind: 'videoinput', deviceId: 'own', label: 'FaceTime HD Camera' }] });
  const image = await captureFrame({ media, video: fakeVideo(), canvas: fakeCanvas(), wait: instant });
  assert.ok(image);
  assert.equal(media.opens.length, 2);
  assert.equal(media.opens[0].stream.track.stopped, true, 'The doorbell was closed');
  assert.deepEqual(media.opens[1].constraints.video.deviceId, { exact: 'own' });
});

test('when only home cameras exist, no frame is taken from any of them', async () => {
  const canvas = fakeCanvas(), media = fakeMedia({ labels: ['Ring Doorbell'], devices: [{ kind: 'videoinput', deviceId: 'ring', label: 'Ring Doorbell' }] });
  await assert.rejects(captureFrame({ media, video: fakeVideo(), canvas, wait: instant }), error => error.code === 'home_only');
  assert.equal(media.opens[0].stream.track.stopped, true);
  assert.equal(canvas.drawn.length, 0);
  const sneaky = fakeMedia({ labels: ['Ring Doorbell', 'Ring Doorbell'], devices: [{ kind: 'videoinput', deviceId: 'mislabeled', label: 'Camera' }] });
  await assert.rejects(captureFrame({ media: sneaky, video: fakeVideo(), canvas, wait: instant }), error => error.code === 'home_only');
  assert.equal(sneaky.opens.every(item => item.stream.track.stopped), true);
});

test('turning it off during the countdown closes the camera and takes no frame', async () => {
  const controller = new AbortController(), media = fakeMedia(), canvas = fakeCanvas();
  const running = captureFrame({ media, video: fakeVideo(), canvas, signal: controller.signal, onLive: () => controller.abort() });
  await assert.rejects(running, error => error.code === 'cancelled');
  assert.equal(media.opens[0].stream.track.stopped, true);
  assert.equal(canvas.drawn.length, 0);
});

test('stopping before it opens never opens it', async () => {
  const controller = new AbortController(), media = fakeMedia();
  controller.abort();
  await assert.rejects(captureFrame({ media, video: fakeVideo(), canvas: fakeCanvas(), signal: controller.signal }), error => error.code === 'cancelled');
  assert.equal(media.opens.length, 0);
});

test('a video that never produces a picture fails and still closes', async () => {
  const media = fakeMedia();
  await assert.rejects(captureFrame({ media, video: fakeVideo(0, 0), canvas: fakeCanvas(), wait: instant }), error => error.code === 'failed');
  assert.equal(media.opens[0].stream.track.stopped, true);
});

test('browser camera errors map to what MERLIN can say', () => {
  const cases = { NotAllowedError: 'denied', SecurityError: 'denied', NotFoundError: 'none', OverconstrainedError: 'none', NotReadableError: 'busy', AbortError: 'busy', TypeError: 'failed' };
  for (const [name, code] of Object.entries(cases)) assert.equal(cameraErrorCode(named(name)), code, name);
  assert.equal(cameraErrorCode(named('Error', { code: 'home_only' })), 'home_only');
  assert.equal(cameraErrorCode(undefined), 'failed');
});

function fakeContext() {
  const ops = [];
  const context = { ops, fillStyle: '', strokeStyle: '', lineWidth: 0, font: '', textAlign: 'start', measureText: text => ({ width: text.length * 10 }) };
  for (const name of ['fillRect', 'strokeRect', 'drawImage', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'stroke']) context[name] = (...args) => ops.push([name, ...args]);
  return context;
}
const calls = (context, name) => context.ops.filter(op => op[0] === name);

test('the viewfinder fits the whole picture without cropping or stretching it', () => {
  // The real viewfinder is about 2.88:1, so a portrait frame sits in the middle with dark sides.
  const context = fakeContext(), source = { videoWidth: 682, videoHeight: 1024 };
  paintViewfinder(context, 2074, 720, { source });
  const [, drawn, left, top, width, height] = calls(context, 'drawImage')[0];
  assert.equal(drawn, source);
  assert.equal(height, 720);
  assert.ok(Math.abs(width / height - 682 / 1024) < 1e-9, 'Same shape as the frame');
  assert.equal(top, 0);
  assert.ok(Math.abs(left - (2074 - width) / 2) < 1e-9, 'Centered');
});

test('a wide feed is fitted whole too', () => {
  const context = fakeContext();
  paintViewfinder(context, 2074, 720, { source: { videoWidth: 1920, videoHeight: 1080 } });
  const [, , , , width, height] = calls(context, 'drawImage')[0];
  assert.ok(Math.abs(width / height - 16 / 9) < 1e-9);
  assert.ok(width <= 2074 && height <= 720);
});

test('SAM\'s boxes land on the picture, with one tag per kind of thing', () => {
  const context = fakeContext(), source = { width: 682, height: 1024 };
  const segments = [{ label: 'shoes', x1: 278, y1: 862, x2: 325, y2: 914, width: 682, height: 1024 }, { label: 'shoes', x1: 359, y1: 864, x2: 400, y2: 916, width: 682, height: 1024 }, { label: 'shirt', x1: 242, y1: 338, x2: 437, y2: 586, width: 682, height: 1024 }];
  paintViewfinder(context, 2074, 720, { source, segments });
  const [, , pictureLeft, , pictureWidth, pictureHeight] = calls(context, 'drawImage')[0];
  const boxes = calls(context, 'strokeRect');
  assert.equal(boxes.length, 3);
  const scale = pictureHeight / 1024, shirt = boxes.find(([, , top]) => Math.abs(top - 338 * scale) < 1e-6);
  assert.ok(Math.abs(shirt[1] - (pictureLeft + 242 * scale)) < 1e-6);
  assert.ok(Math.abs(shirt[3] - 196 * scale) < 1e-6, 'x2 is inclusive');
  assert.ok(pictureWidth > 0);
  assert.deepEqual(calls(context, 'fillText').map(op => op[1]).sort(), ['shirt', 'shoes']);
});

test('the viewfinder shows the count and the note, and never paints a fake feed', () => {
  const waiting = fakeContext();
  paintViewfinder(waiting, 2074, 720, { note: 'Starting the camera…' });
  assert.equal(calls(waiting, 'drawImage').length, 0, 'No picture until there is a real one');
  assert.deepEqual(calls(waiting, 'fillText').map(op => op[1]), ['Starting the camera…']);
  const counting = fakeContext();
  paintViewfinder(counting, 2074, 720, { source: { width: 10, height: 10 }, count: 2 });
  assert.deepEqual(calls(counting, 'fillText').map(op => op[1]), ['2']);
  assert.equal(calls(counting, 'stroke').length, 1, 'The authored corner brackets stay');
});

test('a look moves through MERLIN\'s camera face, and a filler cannot take it away', () => {
  const o = new Orchestrator({ render: () => {} });
  o.begin('turn');
  o.progress('turn', [{ stage: 'camera_capture', tool: 'camera_look', capture_id: 'a', at_ms: 1 }]);
  assert.equal(o.view.destination, 'camera');
  assert.equal(o.view.label, 'Get in frame…');
  o.acknowledgment(true);
  assert.equal(o.view.destination, 'camera', 'The viewfinder is how the person gets in frame');
  o.acknowledgment(false);
  o.progress('turn', [{ stage: 'camera_analyzing', tool: 'camera_look', at_ms: 2 }]);
  assert.equal(o.view.destination, 'camera');
  assert.equal(o.view.label, 'Taking a good look…');
  assert.equal(o.looked('turn'), true);
  assert.equal(o.view.label, 'Here’s what I found');
  assert.equal(o.looked('other'), false);
  o.reply('turn');
  assert.equal(o.view.destination, 'face', 'The mouth is hidden in camera mode, so it answers from the face');
});

test('camera mode opens no panel and shows no panel controls', () => {
  const o = new Orchestrator({ render: () => {} });
  o.begin('turn');
  o.progress('turn', [{ stage: 'tool_start', tool: 'camera_look', at_ms: 1 }]);
  assert.equal(o.pending, null);
  assert.equal(presentationLayout({ destination: 'camera', panels: { left: null, right: null } }).showControls, false);
});
