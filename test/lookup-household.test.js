import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Assistant } from '../src/assistant.js';
import { LOOKUP_REPLIES } from '../src/lookup.js';
import { MAX_LOOKUP_ENFORCEMENTS } from '../src/limits.js';
import { call, chat, reply, scriptedMeta, startApp, tempDir } from './memory-v2-helpers.js';

const search = (query = 'synthetic query', results = [{ title: 'Pet blog', url: 'https://example.org/pets' }]) => ({ type: 'web_search_call', id: `ws_${randomUUID()}`, status: 'completed', action: { type: 'search', query }, results });
const hasSearch = tools => tools.some(tool => tool.type === 'web_search');
const hasPreparation = tools => tools.some(tool => tool.name === 'prepare_web_search');
const hasPageReader = tools => tools.some(tool => tool.name === 'read_web_page');
const webEvents = data => data.tool_events.filter(event => event.tool === 'web_search');
const assertNoWebTools = tools => {
  assert.equal(hasSearch(tools), false, 'web_search is not offered');
  assert.equal(hasPreparation(tools), false, 'there is no step to enable it');
  assert.equal(hasPageReader(tools), false, 'pages cannot be read either');
};
const finalAssistantText = app => app.store.snapshot().conversations.findLast(item => item.role === 'assistant').text;
const app = async (t, engine, steps) => {
  const meta = scriptedMeta(steps);
  return startApp(t, await tempDir(t), { meta, engine });
};

for (const engine of ['legacy', 'v2']) {
  test(`${engine}: a household question answered by finalized memory never searches, and the answer is not discarded`, async t => {
    const { app: merlin, meta } = await app(t, engine, [(_input, { tools, instructions }) => {
      assertNoWebTools(tools);
      assert.match(instructions, /Web search is off/);
      assert.match(instructions, /Remaining for this user request: 0 web-search calls/);
      assert.match(instructions, /sunporch/, 'the saved answer reaches the model');
      assert.doesNotMatch(instructions, /Lookup required/);
      return [reply('On the sunporch, mister.')];
    }]);
    await merlin.memory.putManualFact({ content: 'Biscuit naps on the sunporch.', subject: 'Biscuit' });
    const { status, data } = await chat(merlin, 'Where does Biscuit nap?');
    assert.equal(status, 200);
    assert.equal(meta.calls.length, 1, 'one model round: nothing was discarded or retried');
    assert.match(data.reply, /sunporch/);
    assert.equal(data.lookup, undefined);
    assert.deepEqual(webEvents(data), []);
    assert.ok(data.trace.events.some(event => event.stage === 'lookup' && event.data?.level === 'household'));
  });

  test(`${engine}: a household question answered earlier in the conversation never searches`, async t => {
    const { app: merlin, meta } = await app(t, engine, [
      [reply('Got it.')],
      (input, { tools }) => {
        assertNoWebTools(tools);
        assert.ok(JSON.stringify(input).includes('sunporch'), 'the conversation supplies the answer');
        return [reply('On the sunporch.')];
      },
    ]);
    const session = randomUUID();
    assert.equal((await chat(merlin, 'Just so you know, my dog Biscuit naps on the sunporch.', session)).status, 200);
    const { status, data } = await chat(merlin, 'Where does Biscuit nap?', session);
    assert.equal(status, 200);
    assert.equal(meta.calls.length, 2);
    assert.match(data.reply, /sunporch/);
    assert.deepEqual(webEvents(data), []);
  });

  test(`${engine}: a name that memory has nothing about is not forced into a search, and "I don't know" is delivered`, async t => {
    const dontKnow = "I don't know where Biscuit naps. Where does Biscuit like to nap?";
    const { app: merlin, meta } = await app(t, engine, [(_input, { tools, instructions }) => {
      assert.equal(hasSearch(tools), false, 'search is not offered up front');
      assert.equal(hasPreparation(tools), true, 'the model can still ask for it when the name is a public one');
      assert.match(instructions, /do not search the web for it/);
      assert.doesNotMatch(instructions, /Lookup required/);
      return [reply(dontKnow)];
    }]);
    const { status, data } = await chat(merlin, 'Where does Biscuit nap?');
    assert.equal(status, 200);
    assert.equal(meta.calls.length, 1, 'the honest answer is not discarded for a search-only retry');
    assert.ok(data.reply.includes(dontKnow));
    assert.equal(data.lookup, undefined);
    assert.deepEqual(webEvents(data), []);
  });

  test(`${engine}: if the model searches anyway, code labels the result as general information everywhere it is kept`, async t => {
    const claim = 'He does a rotating nap tour of sunbeams and was found on the dishwasher rack.';
    const { app: merlin, meta } = await app(t, engine, [
      [call('prepare_web_search', {}, 'prep')],
      (_input, { tools, instructions }) => {
        assert.equal(hasSearch(tools), true);
        assert.doesNotMatch(instructions, /Lookup required/, 'the search stays the model\'s own choice');
        return [search('Where does Biscuit nap'), reply(claim)];
      },
      (input, { instructions }) => {
        const replayed = input.findLast(item => item.type === 'message' || item.role === 'assistant');
        assert.ok(replayed.content[0].text.includes(LOOKUP_REPLIES.general), 'the next turn replays the labeled text');
        assert.doesNotMatch(instructions, /Lookup required/);
        return [reply('Understood.')];
      },
    ]);
    const session = randomUUID();
    const { status, data } = await chat(merlin, 'Where does Biscuit nap?', session);
    assert.equal(status, 200);
    assert.equal(data.lookup.policy, 'unknown_subject');
    assert.equal(data.lookup.state, 'searched');
    assert.equal(data.lookup.labeled_general, true);
    assert.ok(data.reply.indexOf(LOOKUP_REPLIES.general) >= 0 && data.reply.indexOf(LOOKUP_REPLIES.general) < data.reply.indexOf('rotating nap tour'), 'the label comes before the web text');
    assert.ok(finalAssistantText(merlin).includes(LOOKUP_REPLIES.general), 'the archive never holds the unlabeled claim');
    assert.deepEqual(data.sources.map(source => source.url), ['https://example.org/pets']);
    assert.equal((await chat(merlin, 'Thanks, what else do you know?', session)).status, 200);
    assert.deepEqual(meta.steps, []);
  });

  test(`${engine}: an explicit "look it up" about the household is still enforced, and its result is labeled`, async t => {
    const { app: merlin, meta } = await app(t, engine, [
      (_input, { tools, instructions }) => {
        assert.equal(hasSearch(tools), true, 'memory holding the answer does not cancel the request');
        assert.match(instructions, /searching is mandatory/);
        assert.match(instructions, /Never present a result as a fact/);
        return [reply('On the sunporch.')];
      },
      (_input, { tools }) => {
        assert.deepEqual(tools, [{ type: 'web_search' }], 'a skipped explicit lookup retries with search only');
        return [search('where does Biscuit nap'), reply('Many dogs nap in sunbeams.')];
      },
    ]);
    await merlin.memory.putManualFact({ content: 'Biscuit naps on the sunporch.', subject: 'Biscuit' });
    const { status, data } = await chat(merlin, 'Where does Biscuit nap? Look it up.');
    assert.equal(status, 200);
    assert.equal(meta.calls.length, 2);
    assert.equal(data.lookup.policy, 'explicit');
    assert.equal(data.lookup.state, 'enforced');
    assert.equal(data.lookup.labeled_general, true);
    assert.ok(data.reply.includes(LOOKUP_REPLIES.general));
  });

  test(`${engine}: an explicit lookup that cannot run says so, with no label and no memory answer`, async t => {
    const draft = 'On the sunporch, by recollection alone.';
    const { app: merlin } = await app(t, engine, Array.from({ length: 1 + MAX_LOOKUP_ENFORCEMENTS }, () => [reply(draft)]));
    const { data } = await chat(merlin, 'Where does Biscuit nap? Look it up.');
    assert.equal(data.reply, LOOKUP_REPLIES.failed);
    assert.equal(data.lookup.state, 'failed');
    assert.equal(data.lookup.labeled_general, undefined);
  });

  test(`${engine}: real web questions still search and are not labeled, even when memory mentions the topic`, async t => {
    const { app: merlin, meta } = await app(t, engine, [
      (_input, { tools }) => { assert.equal(hasSearch(tools), true); return [reply('Canberra.')]; },
      (_input, { tools }) => { assert.deepEqual(tools, [{ type: 'web_search' }]); return [search('capital of australia'), reply('Canberra is the capital.')]; },
      (_input, { tools }) => { assert.equal(hasSearch(tools), true); return [search('weather springfield'), reply('Rain is likely.')]; },
      (_input, { tools }) => { assert.equal(hasSearch(tools), true); return [search('bitcoin price'), reply('It is about ten dollars.')]; },
    ]);
    await merlin.memory.putManualFact({ content: 'We visited Australia last year.' });
    await merlin.memory.putManualFact({ content: 'Our town is Springfield.' });
    await merlin.memory.putManualFact({ content: 'We hold a little Bitcoin.' });
    const capital = await chat(merlin, "what's the capital of Australia?");
    assert.equal(capital.data.lookup.policy, 'required');
    assert.equal(capital.data.lookup.state, 'enforced');
    assert.ok(!capital.data.reply.includes(LOOKUP_REPLIES.general));
    const weather = await chat(merlin, "What's the weather in Springfield?");
    assert.equal(weather.data.lookup.state, 'done');
    assert.ok(!weather.data.reply.includes(LOOKUP_REPLIES.general));
    const price = await chat(merlin, 'what is the price of bitcoin?');
    assert.equal(price.data.lookup.state, 'done');
    assert.equal(meta.calls.length, 4);
  });

  test(`${engine}: an owned subject with nothing in memory gets no web tools and no retry`, async t => {
    const { app: merlin, meta } = await app(t, engine, [(_input, { tools, instructions }) => {
      assertNoWebTools(tools);
      assert.match(instructions, /say plainly that you don't know/);
      return [reply("I don't know yet.")];
    }]);
    const { status, data } = await chat(merlin, 'Where does my dog nap?');
    assert.equal(status, 200);
    assert.equal(meta.calls.length, 1);
    assert.deepEqual(webEvents(data), []);
  });

  test(`${engine}: a saved ban on web search still removes search from an unfamiliar name`, async t => {
    const { app: merlin, meta } = await app(t, engine, [
      [call('memory_save_rule', { kind: 'tool_deny', value: 'web_search', scope: 'tools', source_quote: 'Never search the web.', explanation: 'Block web search.', ...(engine === 'v2' ? { applies: 'ongoing' } : {}) }, 'ban')],
      [reply('Understood.')],
      (_input, { tools }) => {
        assert.equal(hasSearch(tools), false);
        assert.equal(hasPreparation(tools), false);
        return [reply("I don't know.")];
      },
    ]);
    const session = randomUUID();
    assert.equal((await chat(merlin, 'Never search the web.', session)).status, 200);
    assert.equal((await chat(merlin, 'Where does Biscuit nap?', session)).status, 200);
    assert.equal(meta.calls.length, 3);
  });
}

test('without any memory runtime, a household question still has no web tool', async () => {
  const calls = [];
  const assistant = new Assistant({ timers: {}, meta: { async respond(input, tools, instructions) {
    calls.push({ tools, instructions });
    return [reply("I don't know yet.")];
  } } });
  const result = await assistant.run({ message: 'Where does my dog nap?', time_zone: 'UTC', request_id: randomUUID(), session_id: randomUUID(), source_id: randomUUID() });
  assert.equal(hasSearch(calls[0].tools), false);
  assert.match(calls[0].instructions, /Web search is off/);
  assert.equal(result.lookup, undefined);
});
