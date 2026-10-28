const $ = id => document.getElementById(id);
let snapshot, polling = false, resultSignature = '', referenceSignature = '', exportUrl, initialControls = true, connectionError = false;
const time = value => `${(value / 1000).toFixed(2)} s`;
function element(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function showError(error, connection = false) { connectionError = Boolean(error && connection); $('error').hidden = !error; $('error').textContent = error?.message || ''; }
function pauseOtherAudio(current) { document.querySelectorAll('audio').forEach(other => { if (other !== current) other.pause(); }); }
async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'The local server could not complete the request.'); return value;
}
function updateControls() {
  const busy = snapshot?.busy === true;
  $('count').textContent = `${$('text').value.length} / 600`;
  $('run').disabled = !snapshot || busy || !$('text').value.trim() || !document.querySelector('#model-options input:checked');
  $('stop').disabled = !busy;
  for (const id of ['text','passes','use-reference','reference-file','reference-name','transcript','save-reference']) $(id).disabled = busy;
  $('use-reference').disabled = busy || !snapshot?.reference;
  $('use-reference-label').textContent = snapshot?.reference ? 'Use saved reference for cloning models' : 'Add a voice reference below to enable cloning';
  document.querySelectorAll('#model-options input').forEach(input => { input.disabled = busy; });
}
function renderModels(models) {
  for (const model of models) {
    let input = $(`select-${model.id}`);
    if (!input) {
      if (!$('model-options').querySelector('label')) $('model-options').replaceChildren();
      const label = element('label', undefined, 'model-option'); input = element('input'); input.type = 'checkbox'; input.id = `select-${model.id}`; input.value = model.id; input.checked = true;
      const text = element('span', model.name); const help = element('small'); help.id = `model-state-${model.id}`; text.append(help); label.append(input,text); $('model-options').append(label); input.addEventListener('change',updateControls);
    }
    $(`model-state-${model.id}`).textContent = model.available ? `${model.size} · ${model.cloneAvailable === false ? 'Built-in voice only' : model.requiresReference && (!snapshot.reference || !$('use-reference').checked) ? 'Needs reference' : 'Ready'}` : model.reason || 'Setup needed';
    $(`model-state-${model.id}`).title = model.runtime || '';
  }
}
function metric(label, value) { const group = element('div'); group.append(element('dt',label),element('dd',value)); return group; }
function renderResults(run) {
  const signature = JSON.stringify(run); if (signature === resultSignature) return; resultSignature = signature;
  if (!run) { $('results').replaceChildren(); $('result-context').textContent = 'Run a comparison to hear real generated audio here.'; $('download').hidden = true; if (exportUrl) URL.revokeObjectURL(exportUrl); exportUrl = null; return; }
  $('result-context').textContent = `“${run.text}” · ${run.reference ? `Reference: ${run.reference}. Kokoro uses Fenrir.` : 'Built-in voices. Qwen requires a reference.'}`;
  // Only replace a pass when its contents change; polling must not interrupt playing audio.
  for (const modelId of [...new Set(run.results.map(result => result.model))]) {
    const model = snapshot.models.find(model => model.id === modelId);
    let row = $(`result-${modelId}`);
    if (!row || row.dataset.run !== run.id) {
      if (row) row.remove();
      row = element('article',undefined,'result'); row.id = `result-${modelId}`; row.dataset.run = run.id;
      const title = element('div',undefined,'result-title'); const link = element('a','Model source'); link.href = model.source; link.target = '_blank'; link.rel = 'noreferrer'; title.append(element('h3',model.name),link);
      const runtime = element('p',model.runtime || model.description,'runtime'); runtime.id = `runtime-${modelId}`;
      const passes = element('div',undefined,'passes'); row.append(title,runtime,passes); $('results').append(row);
    }
    const completed = run.results.find(result => result.model === modelId && result.status === 'complete');
    if (completed) $(`runtime-${modelId}`).textContent = `${completed.runtime} · ${completed.voiceMode}`;
    for (const result of run.results.filter(result => result.model === modelId)) {
      const id = `pass-${modelId}-${result.pass}`; let pass = $(id); const stamp = JSON.stringify(result);
      if (pass?.dataset.stamp === stamp) continue;
      const next = element('div',undefined,'pass'); next.id = id; next.dataset.stamp = stamp; next.append(element('p',result.pass === 0 ? 'First request · new worker' : 'Warm repeat · same worker','pass-heading'));
      if (result.status === 'complete') {
        const metrics = element('dl',undefined,'metrics'); metrics.append(metric('Total wait',time(result.wallMs)),metric('Generation',time(result.synthesisMs)),metric('Audio length',`${result.durationSeconds.toFixed(2)} s`));
        const audio = element('audio'); audio.controls = true; audio.preload = 'metadata'; audio.src = result.audioUrl; audio.setAttribute('aria-label',`${model.name}, ${result.pass ? 'warm repeat' : 'first request'}`);
        audio.addEventListener('play', () => pauseOtherAudio(audio));
        audio.addEventListener('error', () => showError(new Error('This audio file is unavailable. Run this model again.')));
        const detail = element('p',`Load ${time(result.loadMs)} · Reference ${time(result.preparationMs)} · Generation ratio ${result.realtimeFactor.toFixed(2)}×`,'breakdown');
        next.append(metrics,audio,detail);
        const download = element('a','Download WAV'); download.href = result.audioUrl; download.download = `${modelId}-${result.pass ? 'warm' : 'first'}.wav`; download.className = 'breakdown'; next.append(download);
      } else next.append(element('p', result.error || ({ queued:'Waiting for this model.', running:'Generating audio… First-time model compilation can take several minutes.', cancelled:'Stopped.', interrupted:'Interrupted when the server stopped.', skipped:'Not run.' }[result.status] || result.status), `empty ${result.status === 'failed' ? 'failed' : ''}`));
      if (pass) pass.replaceWith(next); else row.querySelector('.passes').append(next);
    }
  }
  document.querySelectorAll('.result').forEach(row => { if (row.dataset.run !== run.id) row.remove(); });
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = URL.createObjectURL(new Blob([JSON.stringify(run,null,2)],{type:'application/json'})); $('download').href = exportUrl; $('download').hidden = false;
}
function renderReference(reference) {
  const signature = JSON.stringify(reference); if (signature === referenceSignature) return; referenceSignature = signature;
  $('reference-label').textContent = reference ? `${reference.label} · ${reference.durationSeconds.toFixed(1)} s` : 'No custom reference saved';
  $('saved-reference').hidden = !reference;
  if (reference) { $('reference-audio').src = `/audio/reference.wav?v=${Date.now()}`; $('saved-transcript').textContent = reference.transcript || 'No transcript saved. Qwen needs the exact words.'; }
  else { $('reference-audio').pause(); $('reference-audio').removeAttribute('src'); $('reference-audio').load(); $('saved-transcript').textContent = ''; }
}
function render(value) {
  snapshot = value; renderModels(value.models);
  if (initialControls && value.run) { $('text').value = value.run.text; document.querySelectorAll('#model-options input').forEach(input=>{input.checked=value.run.results.some(result=>result.model===input.value);}); $('passes').value=value.run.results.some(result=>result.pass===1)?'2':'1'; }
  initialControls = false; renderResults(value.run); renderReference(value.reference); updateControls();
  const active = value.run?.results.find(result => result.status === 'running');
  const complete = value.run?.results.filter(result => result.status === 'complete').length || 0;
  $('status').textContent = value.busy ? `${active ? value.models.find(model => model.id === active.model).name : 'Preparing'} · ${active?.pass ? 'warm repeat' : 'first request'}. ${complete} audio files ready.` : value.run ? `${value.run.status === 'complete' ? 'Comparison complete.' : value.run.status === 'partial' ? 'Comparison finished with unavailable or failed results.' : value.run.status === 'cancelled' ? 'Comparison stopped.' : 'Previous comparison interrupted.'} ${complete} audio files ready.` : 'Ready to compare. Models run one at a time.';
}
async function refresh() { if (polling) return; polling = true; try { render(await api('/api/status')); if (connectionError) showError(null); } catch { showError(new Error('The local server is unavailable. Start npm run voice:compare, then refresh this page.'), true); $('run').disabled = true; } finally { polling = false; } }
$('text').addEventListener('input',updateControls);
$('use-reference').addEventListener('change',()=>renderModels(snapshot.models));
$('reference-audio').addEventListener('play',()=>pauseOtherAudio($('reference-audio')));
$('run').addEventListener('click',async () => { showError(null); $('run').disabled = true; try { await api('/api/run',{text:$('text').value,models:[...document.querySelectorAll('#model-options input:checked')].map(input=>input.value),passes:Number($('passes').value),useReference:$('use-reference').checked}); await refresh(); } catch(error) { showError(error); updateControls(); } });
$('stop').addEventListener('click',async()=> { $('stop').disabled = true; try { render(await api('/api/stop',{})); } catch(error) { showError(error); } });
$('refresh').addEventListener('click',async()=> { $('refresh').disabled = true; showError(null); try { render(await api('/api/refresh',{})); } catch(error) { showError(error); } finally { $('refresh').disabled = false; } });
$('clear').addEventListener('click',async()=> { $('clear').disabled = true; document.querySelectorAll('audio').forEach(audio=>audio.pause()); try { render(await api('/api/clear',{})); $('reference-form').reset(); $('text').value = ''; updateControls(); showError(null); } catch(error) { showError(error); } finally { $('clear').disabled = false; } });
function wav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const string = (offset,text)=>[...text].forEach((char,i)=>view.setUint8(offset+i,char.charCodeAt(0)));
  string(0,'RIFF'); view.setUint32(4,buffer.byteLength-8,true); string(8,'WAVE'); string(12,'fmt '); view.setUint32(16,16,true); view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,rate,true); view.setUint32(28,rate*2,true); view.setUint16(32,2,true); view.setUint16(34,16,true); string(36,'data'); view.setUint32(40,samples.length*2,true);
  samples.forEach((sample,i)=>view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,sample))*32767),true)); return new Uint8Array(buffer);
}
$('reference-form').addEventListener('submit',async event=> {
  event.preventDefault(); showError(null); $('save-reference').disabled = true;
  let context;
  try {
    const file = $('reference-file').files[0]; if (!file || file.size > 20_000_000) throw new Error('Choose an audio file smaller than 20 MB.');
    context = new AudioContext(); const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (decoded.duration < 3 || decoded.duration > 30.1) throw new Error('Choose a reference between 3 and 30 seconds. For Chatterbox, use at least 10 seconds.');
    const offline = new OfflineAudioContext(1,Math.ceil(decoded.duration*24000),24000); const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start(); const rendered = await offline.startRendering();
    const bytes = wav(rendered.getChannelData(0),24000); let binary = ''; for(let offset=0;offset<bytes.length;offset+=8192) binary += String.fromCharCode(...bytes.subarray(offset,offset+8192));
    await api('/api/reference',{audio:btoa(binary),transcript:$('transcript').value,label:$('reference-name').value.trim()||'Custom voice reference'}); await refresh(); $('reference-form').reset();
  } catch(error) { showError(new Error(error.message || 'This browser could not decode that audio. Try a WAV file.')); } finally { await context?.close(); $('save-reference').disabled = false; }
});
await refresh(); setInterval(refresh,1200);
