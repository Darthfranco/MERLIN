// A simulated home for demonstrations, chosen by the owner on November 3, 2026 for the hackathon demo.
//
// Off unless MERLIN_DEMO_HOME=1. It controls nothing physical: its five devices live in this process and start off
// after every restart. It is always labeled: the service is called "Demo home", every receipt names it, and the
// panels say "Demo device · simulated". It goes through the same hub, tools, rules and receipts as a real connector.

const DEVICES = Object.freeze([
  { id: 'living-room-lights', name: 'Living room lights', room: 'Living room', kind: 'light', actions: ['turn_on', 'turn_off', 'toggle', 'set_brightness'] },
  { id: 'kitchen-lights', name: 'Kitchen lights', room: 'Kitchen', kind: 'light', actions: ['turn_on', 'turn_off', 'toggle', 'set_brightness'] },
  { id: 'gym-lights', name: 'Gym lights', room: 'Gym', kind: 'light', actions: ['turn_on', 'turn_off', 'toggle', 'set_brightness'] },
  { id: 'gym-speaker', name: 'Gym speaker', room: 'Gym', kind: 'media', actions: ['turn_on', 'turn_off', 'toggle'] },
  // The preheat range is checked by the hub (ACTIONS.preheat). A real oven's own safety controls would still apply.
  { id: 'oven', name: 'Oven', room: 'Kitchen', kind: 'oven', actions: ['turn_on', 'preheat', 'turn_off'] },
]);

const initialState = device => device.kind === 'light' ? { on: false, brightness: 0 } : device.kind === 'oven' ? { on: false, unit: '°F' } : { on: false };

export function demoHome() {
  let states = new Map(DEVICES.map(device => [device.id, initialState(device)]));
  const read = id => ({ ...states.get(id) });
  return {
    id: 'demo-home', name: 'Demo home', simulated: true,
    summary: 'Simulated lights, oven and speaker for demonstrations. Nothing physical is controlled.',
    fields: [], kinds: ['light', 'media', 'oven'], cacheMs: 0,
    publicConfig: () => ({}),
    async connect() { return { config: { simulated: true }, summary: 'Demo home is ready. Its devices are simulated.' }; },
    async verify() { return { summary: 'Demo home is simulated and always available.' }; },
    async devices() { return DEVICES.map(device => ({ ...device, actions: [...device.actions], state: read(device.id) })); },
    async state(config, device) { return read(device.id); },
    async act(config, device, action, value) {
      const current = read(device.id);
      let next;
      if (action === 'turn_on') next = { ...current, on: true, ...(device.kind === 'light' && !current.brightness ? { brightness: 100 } : {}) };
      else if (action === 'turn_off') next = device.kind === 'oven' ? { on: false, unit: '°F' } : { ...current, on: false, ...(device.kind === 'light' ? { brightness: 0 } : {}) };
      else if (action === 'toggle') return this.act(config, device, current.on ? 'turn_off' : 'turn_on');
      else if (action === 'set_brightness') next = { ...current, on: value > 0, brightness: value };
      else if (action === 'preheat') next = { on: true, temperature: value, unit: '°F' };
      else throw new Error('Unsupported demo action.');
      states.set(device.id, next);
      return { confirmed: true, state: { ...next } };
    },
    async disconnect() {
      states = new Map(DEVICES.map(device => [device.id, initialState(device)]));
      return { revoked: true, message: 'The simulated devices were reset.' };
    },
  };
}
