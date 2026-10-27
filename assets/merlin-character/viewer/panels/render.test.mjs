import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PANEL_WIDTH,PANEL_HEIGHT,PANEL_TYPES,createDemoState,formatDuration,
  panelActions,panelDescription,paintPanel,
} from './render.js';

// A small recording canvas checks semantic output, not pixel-perfect geometry.
// Browser/3D screenshots remain the visual check for these shared painters.
function recordingCanvas(){
  const texts=[],images=[];
  let depth=0;
  const ctx={
    texts,images,font:'32px sans-serif',
    save(){depth++;},restore(){depth--;assert.ok(depth>=0,'balanced canvas restore');},
    measureText(value){return {width:String(value).length*(Number.parseFloat(this.font.match(/[\d.]+px/)?.[0])||32)*.52};},
    fillText(value){texts.push(String(value));},
    drawImage(source){images.push(source);},
    get depth(){return depth;},
  };
  for(const method of ['beginPath','roundRect','fill','stroke','moveTo','lineTo','translate','scale','arc','bezierCurveTo','closePath','ellipse','clip','fillRect']){
    ctx[method]=(...values)=>{
      for(const value of values)if(typeof value==='number')assert.ok(Number.isFinite(value),`${method} receives finite coordinates`);
    };
  }
  return ctx;
}
function render(state,options){
  const ctx=recordingCanvas();
  paintPanel(ctx,PANEL_WIDTH,PANEL_HEIGHT,state,options);
  assert.equal(ctx.depth,0,'painter restores its canvas context');
  return ctx;
}

test('panel catalog has the seven requested portrait designs, including countdown only',()=>{
  assert.equal(PANEL_WIDTH/PANEL_HEIGHT,5/6);
  assert.deepEqual(PANEL_TYPES.map(p=>p.id),['timer','lights','oven','music','schedule','routine-saved','routine']);
  assert.equal(new Set(PANEL_TYPES.map(p=>p.id)).size,PANEL_TYPES.length);
});

test('countdown formats minute, hour, and seven-day boundaries without wrapping',()=>{
  for(const [seconds,expected] of [
    [0,'00:00'],[.1,'00:01'],[1,'00:01'],[59,'00:59'],[60,'01:00'],[61,'01:01'],
    [3599,'59:59'],[3600,'1:00:00'],[3661,'1:01:01'],[86399,'23:59:59'],
    [86400,'24:00:00'],[604800,'168:00:00'],
  ])assert.equal(formatDuration(seconds),expected,`${seconds} seconds`);
  assert.equal(formatDuration(-1),'00:00');
  const timer={...createDemoState('timer'),seconds:604800,durationSeconds:604800};
  assert.ok(render(timer).texts.includes('168:00:00'));
});

test('unknown panel types cannot become a successful fixture, drawing, or control',()=>{
  for(const type of [undefined,null,'clock','thermostat','__proto__']){
    assert.throws(()=>createDemoState(type),TypeError);
    assert.throws(()=>paintPanel(recordingCanvas(),900,1080,{type}),TypeError);
    assert.deepEqual(panelActions({type}),[]);
  }
  assert.deepEqual(panelActions(null),[]);
});

test('pending, unavailable, and unknown states never show successful status or actionable controls',()=>{
  const successOrAction=/^(?:On|Off|All done|Schedule set|Routine saved|Run routine|Run again|Turn on|Turn off|Pause|Resume|Start again|View routine|Remove schedule)$/;
  for(const {id} of PANEL_TYPES){
    for(const status of ['pending','offline','error','unknown','unexpected',undefined]){
      const state={...createDemoState(id),status};
      assert.deepEqual(panelActions(state),[],`${id}/${status} has no action`);
      const {texts}=render(state);
      assert.equal(texts.some(value=>successOrAction.test(value)),false,`${id}/${status} cannot claim success or offer an action`);
      assert.ok(texts.some(value=>['One moment…','Not connected','Couldn’t finish','State unknown'].includes(value)),`${id}/${status} explains its unavailable state`);
    }
  }
});

test('routine save confirmation offers viewing and never running',()=>{
  const state=createDemoState('routine-saved');
  assert.deepEqual(panelActions(state).map(action=>action.id),['view']);
  const {texts}=render(state);
  assert.ok(texts.includes('Routine saved'));
  assert.ok(texts.includes('View routine'));
  assert.equal(texts.some(value=>/^(?:Running…|Run routine|Run again|All done)$/.test(value)),false);
  assert.deepEqual(panelActions({...createDemoState('routine'),status:'running'}),[]);
});

test('known device states give the opposite action without changing their evidence',()=>{
  for(const type of ['lights','oven']){
    for(const status of ['on','off']){
      const state={...createDemoState(type),status};
      const before=structuredClone(state);
      assert.deepEqual(panelActions(state).map(action=>action.label),[status==='on'?'Turn off':'Turn on']);
      assert.ok(render(state).texts.includes(status==='on'?'On':'Off'));
      assert.deepEqual(state,before,'rendering never changes reported device state');
    }
  }
});

test('finished timers, empty music, and removed schedules expose only valid next actions',()=>{
  for(const status of ['done','cancelled'])assert.deepEqual(panelActions({...createDemoState('timer'),status}).map(action=>action.id),['restart']);
  assert.deepEqual(panelActions({...createDemoState('music'),status:'empty'}),[]);
  assert.deepEqual(panelActions({...createDemoState('schedule'),status:'removed'}),[]);
  assert.equal(render({...createDemoState('schedule'),status:'removed'}).texts.includes('Schedule set'),false);
});

test('demo fixtures remain explicit and independent between preview sessions',()=>{
  for(const {id} of PANEL_TYPES){
    const state=createDemoState(id),copy=createDemoState(id);
    assert.equal(state.source,'demo');
    assert.notEqual(state,copy);
    const before=structuredClone(state);render(state);assert.deepEqual(state,before);
    if(state.steps){state.steps.push('Synthetic new step');assert.notDeepEqual(state.steps,copy.steps);}
  }
});

test('routine art follows its supplied key and does not silently reuse tea art',()=>{
  const tea={width:64,height:64},custom={width:64,height:64};
  const state={...createDemoState('routine'),label:'Reading time',artKey:'reading'};
  assert.deepEqual(render(state,{art:{tea,reading:custom}}).images,[custom]);
  assert.deepEqual(render({...state,artKey:undefined},{art:{tea}}).images,[]);
});

test('accessible descriptions do not claim stale playback or heating when inactive or unavailable',()=>{
  for(const status of ['off','pending','offline','error','unknown']){
    const oven={...createDemoState('oven'),status};
    assert.doesNotMatch(panelDescription(oven),/Heating to|180/);
  }
  assert.doesNotMatch(panelDescription({...createDemoState('music'),status:'empty'}),/Slow mornings|MERLIN sessions/);
  assert.doesNotThrow(()=>panelDescription({...createDemoState('routine'),steps:'unsupported input'}));
});
