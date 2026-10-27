import test from 'node:test';
import assert from 'node:assert/strict';
import {TimerAlertQueue} from '../public/companion/timer-alerts.js';

function fixture(){let now=0;const queue=new TimerAlertQueue({now:()=>now});return {queue,advance(ms){now+=ms;}};}
const timer=id=>({id,label:id,status:'completed'});

test('simultaneous finished timers serialize through animation, synthesis and playback',()=>{
  const {queue,advance}=fixture();queue.enqueue(timer('one'));queue.enqueue(timer('two'));
  const first=queue.claim(true);assert.equal(first.id,'one');
  advance(250);assert.equal(queue.claim(true),null);
  queue.accept(first);advance(30_000);assert.equal(queue.claim(true),null);
  queue.release(first);assert.equal(queue.claim(true).id,'two');
});
test('rejected or unacknowledged voice sends stay queued and retry with backoff',()=>{
  const {queue,advance}=fixture();queue.enqueue(timer('one'));
  const first=queue.claim(true);queue.release(first,{retry:true});
  assert.equal(queue.pending.has('one'),true);advance(999);assert.equal(queue.claim(true),null);
  advance(1);const second=queue.claim(true);queue.waiting(second);
  advance(10_000);assert.equal(queue.claim(true),null);
  advance(1999);assert.equal(queue.claim(true),null);advance(1);assert.equal(queue.claim(true).id,'one');
});
test('barge-in releases the active claim without losing unaccepted timers or replaying accepted speech',()=>{
  const {queue,advance}=fixture();queue.enqueue(timer('one'));queue.enqueue(timer('two'));
  const pending=queue.claim(true);queue.interrupt();assert.equal(queue.active,null);
  assert.equal(queue.pending.has('one'),true);assert.equal(queue.claim(false),null);
  advance(1000);const accepted=queue.claim(true);queue.accept(accepted);queue.interrupt();
  assert.equal(queue.pending.has('one'),false);assert.equal(queue.claim(true).id,'two');
  assert.equal(queue.release(pending),false);
});
test('stale completion cannot unlock or delete a newer alert',()=>{
  const {queue,advance}=fixture();queue.enqueue(timer('one'));queue.enqueue(timer('two'));
  const old=queue.claim(true);queue.interrupt();advance(1000);const current=queue.claim(true);
  assert.equal(queue.accept(old),false);assert.equal(queue.release(old),false);assert.equal(queue.active,current);
  queue.accept(current);queue.release(current);assert.equal(queue.claim(true).id,'two');
});
