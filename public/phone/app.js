import {createInitialState, normalizeState, respond, removeMemory} from './demo-engine.js';
import {SERVICES, DEFAULT_CONNECTED_IDS, getService} from './services.js';
import {icon, hydrateIcons} from './icons.js';
import {saveFile, readFile, deleteFile, clearFiles, MAX_FILE_SIZE, MAX_TOTAL_SIZE} from './storage.js';
import {normalizeSpokenText} from '../shared/spoken-text.js';

const $ = id => document.getElementById(id);
const STORAGE_KEY = 'merlin-phone-demo-v1';
const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
const button = (label, className = '', action) => { const node = el('button', label, className); node.type = 'button'; if(action) node.addEventListener('click', action); return node; };
const iconNode = name => { const span = el('span'); span.innerHTML = icon(name); return span; };
let state = createInitialState(), currentView = 'chat', filter = 'all', selectedService, pendingFiles = [];
let requestChannel, faceLoad = 0, pageAway = false;
let generation = 0, busy = false, pendingUpload = false, toastTimeout, face, facePromise, phase = 'idle', soundEnabled = false;
let recognition, recognitionTimer, voiceRevision = 0, voiceTimer, lastFocused, deleteMode;
const objectURLs = new Set();
const pendingBlobs = new Map();
function storageNotice(message) { $('storage-notice').textContent = message; $('storage-notice').hidden = !message; }
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) { state = normalizeState(JSON.parse(saved)); if(JSON.parse(saved).version !== 1) storageNotice('This saved demo version can’t be restored. Your original data has not been overwritten.'); }
  else { for (const id of DEFAULT_CONNECTED_IDS) state.connections[id] = true; }
} catch { storageNotice('Saved data couldn’t be restored. This session still works; changes may not survive a reload.'); }
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); storageNotice(''); return true; }
  catch { storageNotice('Browser storage is unavailable or full. Changes are only kept in this tab until you free space.'); return false; }
}
function toast(message) { clearTimeout(toastTimeout); $('toast').textContent = message; $('toast').hidden = false; toastTimeout = setTimeout(() => { $('toast').hidden = true; }, 4200); }
function bytes(size) { return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
function scrollChat() { requestAnimationFrame(() => { $('chat-scroll').scrollTop = $('chat-scroll').scrollHeight; }); }
function clearObjectURLs() { for(const url of objectURLs) URL.revokeObjectURL(url); objectURLs.clear(); }
function attachmentLink(file) {
  const link = el('a', '', 'attachment'); link.href = '#'; link.download = file.name;
  link.append(iconNode('file'));
  const label = el('span', file.name); label.append(el('small', `${bytes(file.size)} · Saved locally`)); link.append(label, iconNode('download'));
  link.lastChild.classList.add('download-icon');
  let blobURL;
  readFile(file.id).then(blob => {
    if(!link.isConnected) return;
    if(!blob) { label.lastChild.textContent = 'File no longer available on this browser'; link.removeAttribute('download'); return; }
    blobURL = URL.createObjectURL(blob); objectURLs.add(blobURL); link.href = blobURL;
    if(/^image\/(?:png|jpeg|webp|gif)$/.test(file.type)) {
      const preview = el('img'); preview.src = blobURL; preview.alt = file.name; preview.loading = 'lazy';
      link.replaceChildren(preview,label); link.classList.add('image-attachment');
    }
  }).catch(() => { if(link.isConnected) label.lastChild.textContent = 'Local file storage is unavailable'; });
  link.addEventListener('click', event => { if(!blobURL) { event.preventDefault(); toast('This attachment isn’t available. Please attach it again.'); } });
  return link;
}
function renderMessages() {
  clearObjectURLs(); $('messages').replaceChildren(); $('welcome').hidden = state.messages.length > 0;
  for(const message of state.messages) {
    const article = el('article', '', `message message-${message.role}`);
    const meta = el('div', '', 'message-meta');
    meta.append(el('span', message.role === 'assistant' ? 'MERLIN' : 'You', message.role === 'assistant' ? 'assistant-name' : ''));
    if(message.channel === 'voice') { meta.append(iconNode('wave'), el('span','Talk')); }
    const time = new Date(message.createdAt);
    if(!Number.isNaN(time.getTime())) meta.append(el('span',time.toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}), 'message-time'));
    article.append(meta);
    if(message.text) article.append(el('p', message.text, 'message-text'));
    for(const file of message.attachments || []) article.append(attachmentLink(file));
    if(message.receipt) {
      const receipt = message.receipt;
      const tile = el('div', '', 'receipt');
      tile.append(iconNode(({lights:'light',calendar:'calendar',memory:'memory',music:'wave',timer:'calendar',connection:'connections'})[receipt.kind] || 'check'));
      const content = el('div'); content.append(el('p',receipt.title,'receipt-title'),el('p',receipt.detail,'receipt-detail'),el('p','Simulated action','receipt-label'));
      if(receipt.status === 'disconnected' && receipt.connection_id) content.append(button('Open Connections','text-button',() => { location.hash = 'connections'; showService(receipt.connection_id); }));
      tile.append(content); article.append(tile);
    }
    $('messages').append(article);
  }
}
function updateComposer() { $('attach').disabled = busy || pendingUpload; $('message').readOnly = busy; $('send').disabled = busy || pendingUpload || (!$('message').value.trim() && !pendingFiles.length); $('message').style.height = 'auto'; $('message').style.height = `${Math.min($('message').scrollHeight,120)}px`; }
function renderPending() {
  $('pending-files').replaceChildren();
  for(const file of pendingFiles) {
    const item = el('div', '', 'pending-file'); item.append(iconNode('file'),el('span', file.name));
    const remove = button('', 'icon-button', async () => { pendingFiles = pendingFiles.filter(f => f.id !== file.id); pendingBlobs.delete(file.id); renderPending(); updateComposer(); });
    remove.innerHTML = icon('x'); remove.setAttribute('aria-label', `Remove ${file.name}`); item.append(remove); $('pending-files').append(item);
  }
}
async function cleanupFiles(previousMessages = []) {
  const keep = new Set(state.messages.flatMap(message => (message.attachments || []).map(file => file.id)));
  const removed = previousMessages.flatMap(message => message.attachments || []).filter(file => !keep.has(file.id));
  try { await Promise.all(removed.map(file => deleteFile(file.id))); }
  catch { toast('Some removed files could not be deleted. Clear this site’s data in browser settings.'); }
}
async function submit(text, {channel = 'text', preview = false} = {}) {
  if(busy || (!text.trim() && !pendingFiles.length)) return;
  stopVoice(); busy = true; requestChannel = channel; const revision = ++generation;
  const files = channel === 'text' ? [...pendingFiles] : [];
  $('typing').hidden = false; updateComposer();
  if(channel === 'voice') { setPhase('thinking', preview ? 'Thinking · Voice preview' : 'Thinking'); $('voice-caption').textContent = text; }
  else scrollChat();
  await new Promise(resolve => setTimeout(resolve, channel === 'voice' ? 700 : 450));
  if(revision !== generation) return;
  try {
    for(const file of files) {
      if(pendingBlobs.has(file.id)) await saveFile(file.id,pendingBlobs.get(file.id));
      if(revision !== generation) { await deleteFile(file.id).catch(()=>{}); return; }
    }
    const previousMessages = [...state.messages];
    const result = respond(state,text,{channel,attachments:files}); state = result.state;
    if(channel === 'text') { pendingFiles = []; for(const file of files) pendingBlobs.delete(file.id); $('message').value = ''; renderPending(); }
    persist(); renderMessages(); renderMemory(); renderServices(); scrollChat(); void cleanupFiles(previousMessages);
    if(channel === 'voice' && currentView === 'talk') { $('voice-caption').textContent = result.text; speakReply(result.text, preview); }
  } catch {
    if(channel === 'text') { $('message').value = text; pendingFiles = files; renderPending(); }
    toast('That reply couldn’t finish. Your message is ready to try again.');
    setPhase('idle');
  } finally { if(revision === generation) { busy = false; requestChannel = undefined; $('typing').hidden = true; updateComposer(); } }
}
$('chat-form').addEventListener('submit', event => { event.preventDefault(); void submit($('message').value.trim()); });
$('message').addEventListener('input', updateComposer);
$('message').addEventListener('keydown', event => { if(event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) { event.preventDefault(); if(!$('send').disabled) void submit($('message').value.trim()); } });
document.querySelectorAll('[data-prompt]').forEach(node => node.addEventListener('click', () => { void submit(node.dataset.prompt); }));
$('attach').addEventListener('click', () => { $('file-input').click(); });
$('file-input').addEventListener('change', async () => {
  const revision = generation; pendingUpload = true; updateComposer();
  const files = [...$('file-input').files]; $('file-input').value = '';
  for(const file of files) {
    if(revision !== generation) break;
    if(pendingFiles.length >= 8) { toast('Attach up to eight files in one message.'); break; }
    if(file.size > MAX_FILE_SIZE) { toast(`${file.name} is too large. Choose a file under 10 MB.`); continue; }
    const total = state.messages.flatMap(m => m.attachments || []).concat(pendingFiles).reduce((sum,f) => sum + f.size,0);
    if(total + file.size > MAX_TOTAL_SIZE) { toast('The demo has 50 MB of file space. Clear old chats to add more.'); break; }
    const entry = {id:crypto.randomUUID(),name:file.name,type:file.type,size:file.size};
    try { pendingBlobs.set(entry.id,file); pendingFiles.push(entry); }
    catch(error) { toast(error.message); }
  }
  pendingUpload = false; renderPending(); updateComposer();
});

function serviceLogo(service) { const img = el('img','','brand-logo'); img.src = service.logo; img.alt = service.logoKind === 'label' ? `${service.name} name label` : `${service.company || service.name} logo`; img.width=43; img.height=43; img.loading='lazy'; return img; }
function serviceMatches(service, query) { return [service.name,service.company,service.category,service.description,...service.aliases,...service.categoryIds].join(' ').toLowerCase().includes(query); }
function renderServices() {
  $('connected-count').textContent = Object.values(state.connections).filter(Boolean).length;
  const query = $('service-search').value.toLowerCase().trim();
  const matches = SERVICES.filter(service => serviceMatches(service,query) && (filter === 'all' || filter === 'connected' && state.connections[service.id] || filter === service.kind));
  const connected = matches.filter(service => state.connections[service.id]);
  const available = matches.filter(service => !state.connections[service.id]);
  const ordered = [...available.filter(s=>s.kind==='account'),...available.filter(s=>s.kind==='home')];
  const sections = [];
  if(connected.length) sections.push(['Connected', connected]);
  if(ordered.length) sections.push([query ? 'Matching services' : filter === 'home' ? 'Devices & platforms' : 'Add a connection', ordered]);
  $('services').replaceChildren();
  for(const [title,services] of sections) {
    const section = el('section','','service-section'); const heading = el('h2',title); heading.append(el('span',String(services.length))); section.append(heading);
    for(const service of services) {
      const row = button('','service-row',()=>showService(service.id)); row.setAttribute('aria-label',`${service.name}, ${state.connections[service.id] ? 'connected in demo' : 'not connected'}. Manage connection`);
      row.append(serviceLogo(service)); const desc = el('span','','service-description'); desc.append(el('span',service.name,'service-name'));
      if(state.connections[service.id]) { const status=el('span','','service-state'); status.append(iconNode('check'),el('span','Connected · Demo')); desc.append(status); }
      else desc.append(el('span',service.kind==='account' ? service.category : `${service.company} · ${service.difficulty} setup`,'service-subtitle'));
      row.append(desc);
      if(!state.connections[service.id]) row.append(el('span','Connect','service-connect'));
      row.append(iconNode('chevron-right')); section.append(row);
    }
    $('services').append(section);
  }
  $('services-empty').hidden = matches.length > 0;
}
function showService(id, {focus = true} = {}) {
  const service = getService(id); if(!service) return;
  selectedService = id; $('connections-list-view').hidden = true; $('connection-detail').hidden = false;
  const panel = $('connection-detail'); panel.replaceChildren();
  const back = button('','detail-back',()=>closeService()); back.append(iconNode('arrow-left'),el('span','Connections')); panel.append(back);
  const brand = el('div','','detail-brand'); brand.append(serviceLogo(service),el('h1',service.name),el('p',service.description,'detail-description')); panel.append(brand);
  const connected = Boolean(state.connections[id]);
  const status = el('div','','detail-status'); status.append(iconNode(connected?'check':'connections'),el('span',connected?'Connected in this demo':'Ready to try')); panel.append(status);
  if(service.availability === 'restricted') panel.append(el('p', 'Real access is restricted. This only previews a connection; check the provider limitations below.', 'detail-description'));
  const toggle = button(connected ? 'Disconnect' : `Connect ${service.name}`,`primary-button${connected?' disconnect':''}`,()=>{
    state.connections[id] = !Boolean(state.connections[id]); persist(); renderServices(); showService(id,{focus:false});
    toast(state.connections[id] ? `${service.name} connected in the demo.` : `${service.name} disconnected.`);
    panel.querySelector('.primary-button')?.focus();
  }); panel.append(toggle,el('p','Demo only. No sign-in, passwords, or device access.','detail-notice'));
  const guide = el('section','','setup-guide'); guide.append(el('h2',service.kind==='account'?'How this connection works':'Connecting your device'));
  guide.append(el('p',`${service.difficulty[0].toUpperCase()+service.difficulty.slice(1)} setup · ${service.method}`,'setup-level'));
  const steps=el('ol'); for(const step of service.steps) { const li=el('li'); li.append(el('strong',step.title),el('span',step.body)); steps.append(li); } guide.append(steps);
  for(const [title,items] of [['What you’ll need',service.requirements],['Things to know',service.limitations]]) {
    if(!items?.length) continue; const details=el('details'); const summary=el('summary',title); details.append(summary);
    const list=el('ul'); for(const item of items) list.append(el('li',item)); details.append(list); guide.append(details);
  }
  if(service.guideUrl) { const a=el('a','Read the provider’s setup guide','guide-link'); a.href=service.guideUrl;a.target='_blank';a.rel='noopener noreferrer';guide.append(a); }
  panel.append(guide); $('view-connections').scrollTop=0; if(focus) back.focus({preventScroll:true});
}
function closeService() { selectedService=undefined; $('connections-list-view').hidden=false; $('connection-detail').hidden=true; renderServices(); $('service-search').focus({preventScroll:true}); }
$('service-search').addEventListener('input',renderServices);
document.querySelectorAll('[data-filter]').forEach(node => node.addEventListener('click',()=>{ filter=node.dataset.filter; document.querySelectorAll('[data-filter]').forEach(item=>{item.classList.toggle('selected',item===node);item.setAttribute('aria-pressed',String(item===node));});renderServices(); }));

function showDialog(id) { lastFocused=document.activeElement; $(id).showModal(); }
function closeDialog(id) { $(id).close(); lastFocused?.focus(); }
document.querySelectorAll('[data-close]').forEach(node=>node.addEventListener('click',()=>closeDialog(node.dataset.close)));
for(const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeDialog(dialog.id);}});
function openSettings(){stopVoice();renderMemory();$('delete-confirm').hidden=true;showDialog('settings-dialog');}
$('memory-open').addEventListener('click',openSettings); $('connection-settings').addEventListener('click',openSettings);
function renderMemory(){
  $('memory-list').replaceChildren(); $('memory-empty').hidden=state.memories.length>0;
  for(const memory of state.memories){
    const item=el('div','','memory-item');item.append(el('p',memory.text));
    const edit=button('','icon-button',()=>{
      item.replaceChildren();const form=el('form','','memory-edit'),field=el('textarea');field.value=memory.text;field.rows=3;field.maxLength=500;field.required=true;field.setAttribute('aria-label','Edit saved memory');
      const actions=el('div'),save=button('Save','small-button');save.type='submit';actions.append(save,button('Cancel','small-button',renderMemory));form.append(field,actions);item.append(form);field.focus();
      form.addEventListener('submit',event=>{event.preventDefault();const value=field.value.trim();if(!value)return;const previousMessages=[...state.messages];const candidate=normalizeState(state);removeMemory(candidate,memory.id);const result=respond(candidate,`Remember ${value}`,{channel:'text'});if(!candidate.memories.some(m=>m.text.toLowerCase()===value.replace(/[.!]$/,'').toLowerCase())){toast(result.text);return;}stopVoice();generation++;busy=false;state=candidate;persist();renderMessages();renderMemory();resetVoiceCaption();$('typing').hidden=true;updateComposer();void cleanupFiles(previousMessages);toast('Memory updated in Chat and Talk.');});
    });edit.innerHTML=icon('edit');edit.setAttribute('aria-label',`Edit memory: ${memory.text}`);
    const remove=button('','icon-button',()=>{stopVoice();generation++;busy=false;const previousMessages=[...state.messages];removeMemory(state,memory.id);persist();renderMemory();renderMessages();resetVoiceCaption();$('typing').hidden=true;updateComposer();toast('Memory and its conversation copies removed.');void cleanupFiles(previousMessages);});remove.innerHTML=icon('trash');remove.setAttribute('aria-label',`Delete memory: ${memory.text}`);item.append(edit,remove);$('memory-list').append(item);
  }
  const attachments=state.messages.flatMap(m=>m.attachments||[]);$('storage-summary').textContent=`${state.messages.length} messages · ${state.memories.length} memories · ${attachments.length} attachments`;
}
$('memory-form').addEventListener('submit',event=>{event.preventDefault();const value=$('memory-input').value.trim();if(!value)return;stopVoice();generation++;busy=false;const result=respond(state,`Remember ${value}`,{channel:'text'});persist();renderMessages();renderMemory();$('typing').hidden=true;updateComposer();$('memory-input').value='';toast(result.text);});
function requestDelete(mode){deleteMode=mode;$('delete-description').textContent=mode==='all'?'Delete chats, memories, attachments, and connections from this demo? This cannot be undone.':'Delete all chat messages and attachments? Your saved memories and connections will stay.';$('delete-confirm').hidden=false;$('delete-cancel').focus();}
$('clear-chat').addEventListener('click',()=>requestDelete('chat'));$('reset-demo').addEventListener('click',()=>requestDelete('all'));$('delete-cancel').addEventListener('click',()=>{$('delete-confirm').hidden=true;});
$('delete-confirm-button').addEventListener('click',async()=>{
  stopVoice();generation++;busy=false;pendingFiles=[];pendingBlobs.clear();clearObjectURLs();
  if(deleteMode==='all')state=createInitialState();else state.messages=[];
  const saved=persist();
  let filesDeleted=true;try{await clearFiles();}catch{filesDeleted=false;}
  $('message').value='';$('memory-input').value='';$('voice-input').value='';$('typing').hidden=true;$('delete-confirm').hidden=true;
  resetVoiceCaption();renderPending();renderMessages();renderMemory();renderServices();updateComposer();
  if(selectedService)showService(selectedService,{focus:false});
  toast(saved&&filesDeleted ? 'Your local demo data has been deleted.' : 'Some browser data could not be deleted. Clear this site’s data in browser settings.');
});

function setPhase(next,label){phase=next;$('face-stage').dataset.phase=next;face?.setPhase(next);$('voice-state').textContent=label||({idle:'Here when you need me',listening:'Listening',thinking:'Thinking',speaking:'Speaking'})[next];$('talk').dataset.active=String(next!=='idle');$('talk').innerHTML=icon(next==='idle'?'mic':'stop');$('talk').setAttribute('aria-label',next==='idle'?'Talk to MERLIN':'Stop voice conversation');$('talk-label').textContent=next==='idle'?'Tap to talk':'Tap to stop';}
function resetVoiceCaption(){$('voice-caption').textContent='Ask a question. Make yourself at home.';}
function stopVoice(){
  if(busy && requestChannel === 'voice') { generation++; busy=false; requestChannel=undefined; $('typing').hidden=true; updateComposer(); }
  voiceRevision++;clearTimeout(voiceTimer);clearTimeout(recognitionTimer);const active=recognition;recognition=undefined;
  if(active){active.onresult=active.onend=active.onerror=null;active.abort();}
  if('speechSynthesis'in window) speechSynthesis.cancel();
  $('microphone-state').textContent='Microphone off';setPhase('idle');
}
function localVoice(){return ('speechSynthesis'in window ? speechSynthesis.getVoices():[]).find(voice=>voice.localService&&/^en\b/i.test(voice.lang));}
function speakReply(text,preview){
  const revision=voiceRevision;setPhase('speaking',preview?'Speaking · Voice preview':soundEnabled?'Speaking':'Reply ready');
  const finish=()=>{if(revision===voiceRevision){setPhase('idle');$('microphone-state').textContent='Microphone off';}};
  const voice=soundEnabled?localVoice():undefined;
  if(voice){const spokenText=normalizeSpokenText(text);const utterance=new SpeechSynthesisUtterance(spokenText);utterance.voice=voice;utterance.rate=1;utterance.onend=finish;utterance.onerror=()=>{finish();toast('Spoken playback isn’t available. Your reply is on screen.');};speechSynthesis.speak(utterance);voiceTimer=setTimeout(finish,Math.max(10000,Math.min(45000,spokenText.length*95)));}
  else voiceTimer=setTimeout(finish,Math.min(6500,Math.max(2200,text.length*38)));
}
$('sound').addEventListener('click',()=>{
  if(!soundEnabled&&!localVoice()){toast('No on-device voice is available. Replies and face animation still work.');return;}
  soundEnabled=!soundEnabled;$('sound').setAttribute('aria-pressed',String(soundEnabled));$('sound').setAttribute('aria-label',soundEnabled?'Mute spoken replies':'Enable spoken replies');$('sound').innerHTML=icon(soundEnabled?'volume':'volume-off');if(!soundEnabled&&'speechSynthesis'in window)speechSynthesis.cancel();toast(soundEnabled?'Spoken replies on · local device voice':'Spoken replies muted');
});
function openVoicePreview(message){$('voice-availability').textContent=message||'Try a voice conversation with your own words. The microphone stays off.';showDialog('voice-dialog');}
$('voice-preview-open').addEventListener('click',()=>openVoicePreview());
$('voice-form').addEventListener('submit',event=>{event.preventDefault();if(busy){toast('Let this reply finish first.');return;}const text=$('voice-input').value.trim();if(!text)return;closeDialog('voice-dialog');$('voice-input').value='';void previewVoice(text);});
async function previewVoice(text){if(busy)return;stopVoice();const revision=voiceRevision;setPhase('listening','Listening · Voice preview');$('microphone-state').textContent='Preview · Microphone off';$('voice-caption').textContent=text;voiceTimer=setTimeout(()=>{if(revision===voiceRevision)void submit(text,{channel:'voice',preview:true});},1000);}
$('sample-voice').addEventListener('click',()=>{void previewVoice(state.memories.length?'What do you remember about me?':'Turn on the living room lights');});
$('talk').addEventListener('click',async()=>{
  if(phase!=='idle'){if(busy){generation++;busy=false;$('typing').hidden=true;updateComposer();}stopVoice();return;}
  if(busy){toast('Let this reply finish first.');return;}
  const Recognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!Recognition||!('processLocally'in Recognition.prototype)||typeof Recognition.available!=='function'){openVoicePreview('On-device speech recognition isn’t available in this browser. Try the voice preview below; your microphone stays off.');return;}
  stopVoice();const revision=voiceRevision;setPhase('thinking','Checking on-device voice…');
  try{
    const availability=await Recognition.available({langs:['en-US'],processLocally:true});if(revision!==voiceRevision||currentView!=='talk')return;
    if(availability!=='available'){setPhase('idle');openVoicePreview('The English on-device speech pack isn’t installed in this browser. Use voice preview here; no audio is uploaded.');return;}
    const recognizer=new Recognition();recognition=recognizer;recognizer.processLocally=true;recognizer.lang='en-US';recognizer.continuous=false;recognizer.interimResults=true;
    recognizer.onstart=()=>{if(revision!==voiceRevision){recognizer.abort();return;}setPhase('listening');$('microphone-state').textContent='Microphone on · On-device recognition';$('voice-caption').textContent='I’m listening, mister.';};
    recognizer.onresult=event=>{if(revision!==voiceRevision)return;let final='';let partial='';for(let i=0;i<event.results.length;i++){partial+=event.results[i][0].transcript;if(event.results[i].isFinal)final+=event.results[i][0].transcript;}$('voice-caption').textContent=partial;if(final.trim())void submit(final.trim(),{channel:'voice'});};
    recognizer.onerror=event=>{if(revision!==voiceRevision)return;stopVoice();openVoicePreview(event.error==='not-allowed'?'Microphone permission wasn’t granted. You can still try a voice preview.':'On-device recognition couldn’t start. Try the preview below.');};
    recognizer.onend=()=>{if(revision!==voiceRevision)return;recognition=undefined;clearTimeout(recognitionTimer);$('microphone-state').textContent='Microphone off';setPhase('idle');};
    recognizer.start();recognitionTimer=setTimeout(()=>{if(revision===voiceRevision){stopVoice();toast('Microphone stopped after quiet. Tap to talk again.');}},15000);
  }catch{if(revision===voiceRevision){stopVoice();openVoicePreview('On-device recognition isn’t ready in this browser. Try the voice preview below.');}}
});
async function ensureFace(){
  if(face || facePromise || pageAway) return;
  const load=++faceLoad;
  facePromise=import('./face.js').then(({createFace})=>createFace({canvas:$('face-canvas'),onReady:()=>{if(load===faceLoad&&!pageAway){$('face-fallback').hidden=true;$('face-canvas').hidden=false;}},onError:()=>{if(load!==faceLoad)return;face=undefined;facePromise=undefined;$('face-fallback').hidden=false;$('face-canvas').hidden=true;}})).then(result=>{
    if(load!==faceLoad||pageAway){result.destroy();return;}
    face=result;face.setVisible(currentView==='talk');face.setPhase(phase);
  }).catch(()=>{if(load!==faceLoad)return;facePromise=undefined;$('face-fallback').hidden=false;$('face-canvas').hidden=true;});
}
function navigate(){const next=location.hash.slice(1);const view=['chat','talk','connections'].includes(next)?next:'chat';if(currentView==='talk'&&view!=='talk'){if(busy&&phase==='thinking'){generation++;busy=false;$('typing').hidden=true;updateComposer();}stopVoice();}currentView=view;for(const name of ['chat','talk','connections'])$('view-'+name).hidden=name!==view;document.querySelectorAll('[data-view]').forEach(node=>{if(node.dataset.view===view)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');});face?.setVisible(view==='talk');if(view==='talk')void ensureFace();if(view==='connections')renderServices();if(view==='chat')scrollChat();document.title=`MERLIN · ${view==='chat'?'Chat':view==='talk'?'Talk':'Connections'}`;}
window.addEventListener('hashchange',navigate);
document.addEventListener('visibilitychange',()=>{if(document.hidden){if(phase==='thinking'&&currentView==='talk'){generation++;busy=false;$('typing').hidden=true;updateComposer();}stopVoice();}face?.setVisible(!document.hidden&&currentView==='talk');});
window.addEventListener('pagehide',()=>{pageAway=true;faceLoad++;stopVoice();clearObjectURLs();face?.destroy();face=undefined;facePromise=undefined;$('face-fallback').hidden=false;$('face-canvas').hidden=true;});
window.addEventListener('pageshow',event=>{pageAway=false;if(event.persisted){renderMessages();if(currentView==='talk')void ensureFace();}});
window.addEventListener('storage',event=>{if(event.key!==STORAGE_KEY)return;try{generation++;busy=false;stopVoice();state=event.newValue?normalizeState(JSON.parse(event.newValue)):createInitialState();renderMessages();renderMemory();renderServices();resetVoiceCaption();$('typing').hidden=true;updateComposer();if(selectedService)showService(selectedService,{focus:false});}catch{storageNotice('Another tab’s saved data couldn’t load. Reload after checking browser storage.');}});
hydrateIcons();renderMessages();renderMemory();renderServices();updateComposer();navigate();
