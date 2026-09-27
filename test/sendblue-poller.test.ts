import test from 'node:test';
import assert from 'node:assert/strict';
import { SendbluePoller, POLL_OVERLAP_MS as DAY, POLL_HORIZON_MS, type SendbluePollState, type SendbluePollQuery, type SendbluePollOptions } from '../src/sendblue-poller.js';

const signal = new AbortController().signal;
const route = { id: 'chat', sender: '+15555550001', sendblueNumber: '+15555550002' };
const iso = (ms: number) => new Date(ms).toISOString();
function row(id: string, updated: number, sent = updated) {
  return { message_handle: id, date_updated: iso(updated), date_sent: iso(sent), is_outbound: false,
    status: 'RECEIVED', message_type: 'message', from_number: route.sender, sendblue_number: route.sendblueNumber, content: id };
}
function fixture(rows: ReturnType<typeof row>[] = [], checkpoint = 60 * DAY) {
  let now = 60 * DAY;
  const state: SendbluePollState = { activationAtMs: DAY, completedThroughMs: checkpoint, routeActivationAtMs: { chat: DAY } };
  const queries: SendbluePollQuery[] = [], admissions: unknown[] = [], waits: number[] = [];
  const options: SendbluePollOptions = {
    routes: [route], state: () => structuredClone(state), now: () => now,
    checkpoint: async upper => { state.completedThroughMs = upper; },
    receive: async value => { admissions.push(value); },
    wait: async ms => { waits.push(ms); now += ms; },
    list: async query => {
      queries.push(query);
      const matches = rows.filter(r => Date.parse(r.date_updated) >= Date.parse(query.updated_at_gte)
        && Date.parse(r.date_updated) <= Date.parse(query.updated_at_lte)).sort((a, b) => a.date_updated.localeCompare(b.date_updated));
      const data = matches.slice(query.offset, query.offset + 2);
      return { data, pagination: { offset: query.offset, limit: 100, hasMore: query.offset + data.length < matches.length } };
    },
  };
  return { options, state, queries, admissions, waits, rows, setNow: (value: number) => { now = value; } };
}

test('polls all offset pages with inclusive bounds, tied timestamps, attachments and account rate spacing', async () => {
  const f = fixture([row('a', 59 * DAY), row('b', 59 * DAY), row('c', 60 * DAY)]);
  Object.assign(f.rows[1]!, { media_url: 'https://cdn.test/image.png' });
  await new SendbluePoller(f.options).sweep(signal);
  assert.equal(f.admissions.length, 3);
  assert.deepEqual(f.queries.map(q => q.offset), [0, 2]);
  assert.equal(f.queries[0]!.updated_at_gte, iso(59 * DAY));
  assert.equal(f.queries[0]!.updated_at_lte, iso(60 * DAY));
  assert.equal(f.queries[0]!.is_outbound, 'false');
  assert.equal(f.queries[0]!.order_by, 'updatedAt');
  assert.equal(f.queries[0]!.order_direction, 'asc');
  assert.equal(f.queries[0]!.sendblue_number, route.sendblueNumber);
  assert.equal((f.admissions[1] as { media_url: string }).media_url, 'https://cdn.test/image.png');
  assert.deepEqual(f.waits, [110]);
});

test('bounded historical catch-up revisits a message skipped when an earlier offset row moves out', async () => {
  const base = 35 * DAY;
  const f = fixture([row('a', base + 100), row('b', base + 200), row('c', base + 300), row('d', base + 400)], base);
  const list = f.options.list;
  let removed = false;
  f.options.list = async (query, abort) => {
    const result = structuredClone(await list(query, abort));
    if (!removed) { f.rows[1]!.date_updated = iso(61 * DAY); removed = true; }
    return result;
  };
  const poller = new SendbluePoller(f.options);
  assert.equal((await poller.sweep(signal)).caughtUp, false);
  assert.deepEqual(f.admissions.map(x => (x as { message_handle: string }).message_handle), ['a', 'b', 'd']);
  assert.equal(f.state.completedThroughMs, base + DAY / 2);
  await poller.sweep(signal);
  assert.ok(f.admissions.some(x => (x as { message_handle: string }).message_handle === 'c'));
  assert.equal(f.state.completedThroughMs, base + DAY);
  assert.equal(f.queries[2]!.updated_at_gte, iso(base - DAY / 2));
});

test('late visibility inside overlap is recovered next sweep', async () => {
  const f = fixture(); const poller = new SendbluePoller(f.options);
  await poller.sweep(signal);
  f.rows.push(row('late', 60 * DAY - 10000));
  f.setNow(60 * DAY + 5000);
  await poller.sweep(signal);
  assert.equal(f.admissions.length, 1);
});

test('filters outbound, groups, other senders and rolling expired message identities', async () => {
  const f = fixture([row('out', 60 * DAY), row('group', 60 * DAY), row('stranger', 60 * DAY), row('old', 60 * DAY, 20 * DAY), row('fresh', 60 * DAY)]);
  f.rows[0]!.is_outbound = true; f.rows[1]!.message_type = 'group'; f.rows[2]!.from_number = '+15555559999';
  await new SendbluePoller(f.options).sweep(signal);
  assert.deepEqual(f.admissions.map(x => (x as { message_handle: string }).message_handle), ['fresh']);
});

test('route activation excludes historical messages independently of account checkpoint', async () => {
  const f = fixture([row('old-route', 60 * DAY, 59 * DAY), row('new-route', 60 * DAY)]);
  f.state.routeActivationAtMs.chat = 60 * DAY;
  await new SendbluePoller(f.options).sweep(signal);
  assert.equal(f.admissions.length, 1);
});

test('admission and checkpoint failures leave checkpoint unchanged and restart at zero with existing durable dedup', async () => {
  const f = fixture([row('a', 60 * DAY), row('b', 60 * DAY), row('c', 60 * DAY)], 60 * DAY - 1000);
  const durable = new Set<string>(); let fail = true;
  f.options.receive = async value => {
    const id = (value as { message_handle: string }).message_handle;
    if (id === 'b' && fail) throw new Error('storage failed');
    durable.add(id);
  };
  await assert.rejects(new SendbluePoller(f.options).sweep(signal));
  assert.equal(f.state.completedThroughMs, 60 * DAY - 1000);
  fail = false;
  await new SendbluePoller(f.options).sweep(signal);
  assert.deepEqual([...durable], ['a', 'b', 'c']);
  assert.deepEqual(f.queries.map(q => q.offset), [0, 0, 2]);
  f.setNow(60 * DAY + 1000);
  f.options.checkpoint = async () => { throw new Error('rename failed'); };
  await assert.rejects(new SendbluePoller(f.options).sweep(signal));
  assert.equal(f.state.completedThroughMs, 60 * DAY);
});

test('malformed, nonprogressing pages, invalid matching dates and API failures never advance checkpoint', async () => {
  for (const list of [
    async () => ({ data: [], pagination: { hasMore: true, offset: 0 } }),
    async () => ({ data: [], pagination: { hasMore: false, offset: 99 } }),
    async () => ({ data: [{ ...row('bad', 60 * DAY), date_sent: 'bad' }], pagination: { hasMore: false, offset: 0 } }),
    async () => { throw new Error('provider unavailable'); },
  ]) {
    const f = fixture([], 60 * DAY - 1000); f.options.list = list;
    await assert.rejects(new SendbluePoller(f.options).sweep(signal));
    assert.equal(f.state.completedThroughMs, 60 * DAY - 1000);
  }
});

test('recovery beyond 29 days is blocked before network requests', async () => {
  const f = fixture([], 60 * DAY - POLL_HORIZON_MS - 1);
  await assert.rejects(new SendbluePoller(f.options).sweep(signal), /poll_recovery_required/);
  assert.equal(f.queries.length, 0);
});

test('serial run honors provider backoff, safely reports metadata and stops on cancellation', async () => {
  const f = fixture(); const controller = new AbortController(); const statuses: unknown[] = [];
  f.options.onStatus = value => { statuses.push(value); };
  f.options.list = async () => { throw Object.assign(new Error('secret provider body'), { retryAfterMs: 17000 }); };
  f.options.wait = async ms => { f.waits.push(ms); controller.abort(); };
  await new SendbluePoller(f.options).run(controller.signal);
  assert.deepEqual(f.waits, [17000]);
  assert.deepEqual(statuses, [{ state: 'running' }, { state: 'degraded', code: 'poll_request_failed', nextRetryAt: f.options.now!() + 17000 }]);
});

test('abort after durable admission prevents checkpoint and concurrent sweeps are rejected', async () => {
  const f = fixture([row('a', 60 * DAY)], 60 * DAY - 1000);
  const controller = new AbortController(); let release!: () => void;
  f.options.receive = async () => new Promise<void>(resolve => { release = resolve; });
  const poller = new SendbluePoller(f.options); const first = poller.sweep(controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(poller.sweep(signal), /poll_already_running/);
  controller.abort(); release();
  await assert.rejects(first);
  assert.equal(f.state.completedThroughMs, 60 * DAY - 1000);
});

test('account checkpoint waits for every configured line and network failure retries automatically', async () => {
  const f = fixture([], 60 * DAY - 1000); const controller = new AbortController();
  f.options.routes.push({ ...route, id: 'second', sendblueNumber: '+15555550003' });
  f.state.routeActivationAtMs.second = DAY;
  const list = f.options.list; let failed = false; let persisted = 0;
  const checkpoint = f.options.checkpoint;
  f.options.checkpoint = async upper => { persisted++; await checkpoint(upper); };
  f.options.list = async (query, abort) => {
    if (query.sendblue_number === '+15555550003' && !failed) {
      assert.equal(persisted, 0); failed = true; throw new Error('line request failed');
    }
    return list(query, abort);
  };
  f.options.onStatus = status => { if (status.state === 'idle') controller.abort(); };
  await new SendbluePoller(f.options).run(controller.signal);
  assert.equal(persisted, 1);
  assert.equal(f.queries.filter(q => q.sendblue_number === route.sendblueNumber).length, 2);
  assert.ok(f.waits.includes(5000));
});

test('shutdown interrupts the real cadence timer promptly', async () => {
  const f = fixture(); const controller = new AbortController();
  delete f.options.wait;
  f.options.onStatus = status => { if (status.state === 'idle') setTimeout(() => controller.abort(), 10); };
  await new SendbluePoller(f.options).run(controller.signal);
  assert.equal(f.queries.length, 1);
});


test('missing or malformed direction, status and routing cannot be checkpointed as filtered messages', async () => {
  for (const field of ['status', 'is_outbound', 'from_number', 'sendblue_number', 'message_type']) {
    const f = fixture([], 60 * DAY - 1000);
    const malformed: Record<string, unknown> = row('bad', 60 * DAY);
    delete malformed[field];
    f.options.list = async () => ({ data: [malformed], pagination: { hasMore: false, offset: 0 } });
    await assert.rejects(new SendbluePoller(f.options).sweep(signal), /poll_invalid_message/, field);
    assert.equal(f.state.completedThroughMs, 60 * DAY - 1000, field);
    assert.equal(f.admissions.length, 0);
  }
  for (const change of [{ status: 'not-a-status' }, { is_outbound: 'false' }, { from_number: 'invalid' }, { sendblue_number: '+15555550003' }]) {
    const f = fixture([], 60 * DAY - 1000);
    f.options.list = async () => ({ data: [{ ...row('bad', 60 * DAY), ...change }], pagination: { hasMore: false, offset: 0 } });
    await assert.rejects(new SendbluePoller(f.options).sweep(signal), /poll_invalid_message/);
    assert.equal(f.state.completedThroughMs, 60 * DAY - 1000);
  }
});

test('configured fast polling changes healthy cadence while provider errors retain backoff', async () => {
  const f = fixture(); const controller = new AbortController();
  f.options.intervalMs = 1000;
  f.options.wait = async ms => { f.waits.push(ms); controller.abort(); };
  await new SendbluePoller(f.options).run(controller.signal);
  assert.deepEqual(f.waits, [1000]);
  const bad = fixture(); const stop = new AbortController(); bad.options.intervalMs = 1000;
  bad.options.list = async () => { throw new Error('unavailable'); };
  bad.options.wait = async ms => { bad.waits.push(ms); stop.abort(); };
  await new SendbluePoller(bad.options).run(stop.signal);
  assert.deepEqual(bad.waits, [5000]);
});
