/**
 * The local voice makes one piece of speech at a time and refuses a second ("Fenrir is busy"). The spoken lookup line
 * and the answer can be asked for together, so requests wait their turn instead of failing the answer.
 */
export function queuedSpeech(tts) {
  let tail = Promise.resolve();
  const synthesize = (text, options = {}) => {
    const run = tail.then(() => {
      options.signal?.throwIfAborted();
      return tts.synthesize(text, options);
    });
    tail = run.catch(() => {});
    return run;
  };
  return new Proxy(tts, {
    get(target, property) {
      if (property === 'synthesize') return synthesize;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
