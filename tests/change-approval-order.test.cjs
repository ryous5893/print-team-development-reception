const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../reception/workflow.js');
const workflow = globalThis.PrintWorkflow;
const order = { eventId: 'e1', type: 'order', requestId: 'r1', orderId: 'o1',
  product: 'チラシ', paper: '普通紙', quantity: '100', dueDate: '2026-12-01' };
const approve = (eventId, requestId, confirmedDueDate = '') => ({ eventId, type: 'reply',
  requestId, orderId: 'o1', decision: '承認', confirmedDueDate, reason: '' });
const change = (eventId, requestId, quantity, paper, dueDate) => ({ eventId,
  type: 'change', requestId, orderId: 'o1', quantity, paper, dueDate, reason: '変更' });
const base = [order, approve('e2', 'r1'),
  change('e3', 'r2', '200', '厚紙', '2026-12-02'),
  change('e4', 'r3', '300', '光沢紙', '2026-12-03')];

test('後の変更を承認してから古い承認を取り込んでも最新値と製造対象部数を保持する', () => {
  const events = [...base, approve('e5', 'r3', '2026-12-04'), approve('e6', 'r2')];
  for (const state of [workflow.buildState(events),
    workflow.buildState(workflow.readBackup('sales', workflow.exportBackup('sales', events)))]) {
    const current = state.orders.get('o1');
    assert.equal(current.quantity, 300);
    assert.equal(current.paper, '光沢紙');
    assert.equal(current.dueDate, '2026-12-04');
    assert.equal(state.requests.get('r1').targetQuantity, 300);
    assert.equal(state.requests.get('r2').answer, '承認');
    assert.equal(state.requests.get('r2').superseded, true);
  }
});

test('変更1回または依頼順の承認は従来どおり反映する', () => {
  const state = workflow.buildState([...base, approve('e5', 'r2')]);
  assert.equal(state.orders.get('o1').quantity, 200);
  const latest = workflow.buildState([...base, approve('e5', 'r2'), approve('e6', 'r3')]);
  assert.equal(latest.orders.get('o1').quantity, 300);
});
