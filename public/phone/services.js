// Phone-only presentation over the shared Connection Center catalog.
// Every connection here is a local simulation. No credential or account data is collected.
import { CONNECTIONS } from '../connections/catalog.js';

export const SERVICE_CATEGORIES = [
  { id: 'all', label: 'All services' },
  { id: 'Home', label: 'Home' },
  { id: 'Music', label: 'Music' },
  { id: 'Calendar', label: 'Calendar' },
  { id: 'Email', label: 'Email' },
  { id: 'Files', label: 'Files' },
  { id: 'Productivity', label: 'Productivity' },
];
export const groups = SERVICE_CATEGORIES;
export const DEFAULT_CONNECTED_IDS = ['philips-hue', 'google-calendar'];

const logoDetails = {
  'home-assistant': ['home-assistant.svg', '#18BCF2'],
  matter: ['matter.png', '#1B1B1B'],
  'apple-home': ['apple.svg', '#111111'],
  'google-home': ['google-home.svg', '#4285F4'],
  'google-home-mcp': ['google-home.svg', '#4285F4'],
  mqtt: ['mqtt.svg', '#660066'],
  zigbee: ['zigbee.svg', '#EB0443'],
  'z-wave': ['z-wave.png', '#D72228'],
  'philips-hue': ['philips-hue.svg', '#0065D3'],
  shelly: ['shelly.svg', '#4495D1'],
  'tapo-kasa': ['tp-link.svg', '#4ACBD6'],
  sonos: ['sonos.svg', '#111111'],
  'google-cast': ['google-cast.svg', '#4285F4'],
  'lg-webos': ['lg.svg', '#A50034'],
  reolink: ['reolink.png', '#0088D1'],
  'rtsp-onvif': ['camera-standards.svg', '#357A97'],
  'lg-thinq': ['lg.svg', '#A50034'],
  smarthq: ['ge-appliances.png', '#005EB8'],
  'home-connect': ['home-connect.png', '#0099DA'],
  'samsung-smartthings': ['smartthings.svg', '#15BFFF'],
  ring: ['ring.svg', '#1C9AD6'],
  'unifi-protect': ['ubiquiti.svg', '#0559C9'],
  lutron: ['lutron.png', '#376EB2'],
  aqara: ['aqara.png', '#0076FF'],
  eve: ['eve.png', '#242424'],
  ikea: ['ikea.svg', '#0058A3'],
  switchbot: ['switchbot.png', '#E62229'],
  ecobee: ['ecobee.png', '#53B848'],
  'z-wave-thermostats': ['z-wave.png', '#D72228'],
  'yale-august': ['yale.svg', '#FFD900'],
  schlage: ['schlage.png', '#1C2F4F'],
  roborock: ['roborock.png', '#EC152D'],
  irobot: ['irobot.svg', '#6CB86A'],
  levoit: ['vesync.png', '#3179BB'],
  'rabbit-air': ['rabbit-air.png', '#555555'],
  midea: ['midea.png', '#0098D8'],
  gree: ['gree.png', '#1D4F91'],
  rachio: ['rachio.png', '#00A8E0'],
  wallbox: ['wallbox.png', '#121212'],
  enphase: ['enphase.png', '#F47920'],
  ratgdo: ['ratgdo-label.svg', '#39566E'],
  'amazon-echo': ['amazon-alexa.svg', '#00CAFF'],
  'apple-homepod': ['apple.svg', '#111111'],
  eufy: ['eufy.png', '#00A7E0'],
  myq: ['myq-label.svg', '#254D73'],
  spotify: ['spotify.svg', '#1ED760'],
  'apple-music': ['apple-music.svg', '#FA243C'],
  'google-calendar': ['google-calendar.svg', '#4285F4'],
  'outlook-calendar': ['outlook.svg', '#0078D4'],
  gmail: ['gmail.svg', '#EA4335'],
  outlook: ['outlook.svg', '#0078D4'],
  'google-drive': ['google-drive.svg', '#4285F4'],
  dropbox: ['dropbox.svg', '#0061FF'],
  notion: ['notion.svg', '#111111'],
};

function account(id, name, company, category, description, aliases = []) {
  return {
    id, name, company, category, description, aliases,
    categoryIds: [category.toLowerCase()],
    kind: 'account', difficulty: 'easy', availability: 'demo',
    difficultyReason: 'Try the connection locally. A real connection will use the service’s own sign-in.',
    method: 'Demo account connection',
    requirements: ['No account or password is needed for this local demo.'],
    steps: [
      { title: 'Try the connection', body: 'Connect stores a simulated connection on this browser only.' },
      { title: 'Use it with MERLIN', body: 'Supported demo requests return a sample result. No account content is read or changed.' },
    ],
    limitations: ['A real sign-in and service integration are not part of this phone demo.'],
  };
}

const accountServices = [
  {
    ...account('spotify', 'Spotify', 'Spotify', 'Music', 'Your music and playlists, one message away.', ['music', 'playback', 'playlist']),
    limitations: ['Typed demo controls only. Spotify voice control and alarms are unavailable.', 'No Spotify account, track or playlist data is fetched or saved.'],
    supportedChannels: ['text'],
    guideUrl: 'https://developer.spotify.com/documentation/web-api',
  },
  account('apple-music', 'Apple Music', 'Apple', 'Music', 'Bring your music into the conversation.', ['songs', 'playlists']),
  account('google-calendar', 'Google Calendar', 'Google', 'Calendar', 'A little help keeping your day in order.', ['events', 'agenda', 'schedule']),
  account('outlook-calendar', 'Outlook Calendar', 'Microsoft', 'Calendar', 'Your appointments, in one place.', ['events', 'agenda', 'Microsoft 365', 'schedule']),
  account('gmail', 'Gmail', 'Google', 'Email', 'Stay on top of the messages that matter.', ['mail', 'inbox']),
  account('outlook', 'Outlook Mail', 'Microsoft', 'Email', 'Keep your inbox close at hand.', ['email', 'inbox', 'Microsoft 365']),
  account('google-drive', 'Google Drive', 'Google', 'Files', 'Keep helpful documents within reach.', ['documents', 'storage', 'files']),
  account('dropbox', 'Dropbox', 'Dropbox', 'Files', 'A place for the files you share with MERLIN.', ['documents', 'storage']),
  account('notion', 'Notion', 'Notion', 'Productivity', 'Connect the notes and plans you live by.', ['notes', 'pages', 'tasks']),
];

export const SERVICES = [
  ...accountServices,
  ...CONNECTIONS.map((service) => ({ ...service, category: 'Home', kind: 'home' })),
].map((service) => {
  const [file, brandColor] = logoDetails[service.id];
  return {
    ...service,
    logo: `/phone/logos/${file}`,
    brandColor,
    demoOnly: true,
    logoKind: ['ratgdo', 'myq', 'rtsp-onvif'].includes(service.id) ? 'label' : 'brand',
  };
});

export const services = SERVICES;
export function getService(id) {
  return SERVICES.find((service) => service.id === id) ?? null;
}
