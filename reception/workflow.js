(function () {
  'use strict';

  // 両部署の取り込み・書き出しで共通のCSV仕様。
  const interfaces = {
    order:       { name: '製造依頼', from: 'sales', fields: 'requestId orderId product paper quantity dueDate' },
    change:      { name: '注文変更依頼', from: 'sales', fields: 'requestId orderId paper quantity dueDate reason' },
    cancel:      { name: 'キャンセル依頼', from: 'sales', fields: 'requestId orderId reason' },
    proofReply:  { name: '校正回答', from: 'sales', fields: 'orderId proofId proofDecision comment' },
    additional:  { name: '追加製造依頼', from: 'sales', fields: 'requestId orderId quantity dueDate reason' },
    reply:       { name: '依頼回答', from: 'factory', fields: 'requestId orderId decision confirmedDueDate reason' },
    proof:       { name: '校正確認依頼', from: 'factory', fields: 'orderId proofId version instruction responseDueDate' },
    progress:    { name: '製造進捗通知', from: 'factory', fields: 'orderId stage updatedAt expectedDate' },
    delay:       { name: '納期遅延通知', from: 'factory', fields: 'orderId reason expectedDate' },
    finish:      { name: '製造完了報告', from: 'factory', fields: 'orderId requestId completedDate goodQuantity shortageQuantity' }
  };
  for (const definition of Object.values(interfaces)) {
    definition.fields = definition.fields.split(' ');
  }

  const stages = ['準備中', '印刷中', '加工中', '検品中'];
  const requestTypes = ['order', 'change', 'cancel', 'additional'];
  const optionalFields = ['comment', 'confirmedDueDate', 'reason'];
  const positiveFields = ['quantity', 'version'];
  const countFields = ['goodQuantity', 'shortageQuantity'];
  const dateFields = ['dueDate', 'confirmedDueDate', 'responseDueDate', 'expectedDate', 'completedDate'];

  function requireThat(condition, message) {
    if (!condition) throw new Error(message);
  }

  function validateEvent(event) {
    const definition = Object.hasOwn(interfaces, event.type) && interfaces[event.type];
    requireThat(definition, 'CSVの種類が不明です。');
    requireThat(/^[A-Za-z0-9_-]+$/.test(event.eventId), 'イベントIDが不正です。');

    for (const field of definition.fields) {
      const value = event[field];
      requireThat(typeof value === 'string', field + ' がありません。');
      if (!optionalFields.includes(field)) {
        requireThat(value.trim(), field + ' は必須です。');
      }
      if (positiveFields.includes(field) || countFields.includes(field)) {
        requireThat(/^\d+$/.test(value) && Number.isSafeInteger(Number(value)), field + ' は整数で入力してください。');
        requireThat(countFields.includes(field) || Number(value) > 0, field + ' は1以上で入力してください。');
      }
      if (dateFields.includes(field) && value) {
        const date = new Date(value + 'T00:00:00Z');
        requireThat(/^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(date) &&
          date.toISOString().slice(0, 10) === value, field + ' は有効な日付で入力してください。');
      }
      if (field.endsWith('Id')) {
        requireThat(/^[A-Za-z0-9_-]+$/.test(value), field + ' が不正です。');
      }
    }
    requireThat(event.type === 'reply' || event.type === 'order' ||
      !definition.fields.includes('reason') || event.reason.trim(), '理由を入力してください。');
    if (event.type === 'reply') {
      requireThat(['承認', '却下'].includes(event.decision), '依頼回答が不正です。');
      requireThat(event.decision !== '却下' || event.reason.trim(), '却下理由を入力してください。');
    }
    if (event.type === 'proofReply') {
      requireThat(['承認', '修正依頼'].includes(event.proofDecision), '校正回答が不正です。');
      requireThat(event.proofDecision !== '修正依頼' || event.comment.trim(), '修正内容を入力してください。');
    }
    if (event.type === 'progress') {
      requireThat(stages.includes(event.stage), '工程が不正です。');
      requireThat(/^\d{4}-\d{2}-\d{2}T/.test(event.updatedAt) &&
        !isNaN(Date.parse(event.updatedAt)), '更新日時が不正です。');
    }
  }

  function availableOrder(order) {
    return order && order.approved && !order.cancelled;
  }

  function applyEvent(state, event) {
    validateEvent(event);
    const order = state.orders.get(event.orderId);
    const request = state.requests.get(event.requestId);
    const proof = state.proofs.get(event.proofId);

    if (event.type === 'order') {
      requireThat(!order && !request, '注文IDまたは依頼IDが重複しています。');
      state.orders.set(event.orderId, {
        id: event.orderId, originalRequestId: event.requestId, product: event.product,
        paper: event.paper, quantity: Number(event.quantity), dueDate: event.dueDate,
        approved: false, cancelled: false, progress: '', progressAt: '',
        expectedDate: '', delayReason: '', goodQuantity: 0, initialFinished: false, proofStatus: ''
      });
    } else {
      requireThat(order, '該当する注文がありません。先行するCSVを読み込んでください。');
    }

    if (requestTypes.includes(event.type)) {
      requireThat(!request, '依頼IDが重複しています。');
      if (event.type !== 'order') {
        requireThat(availableOrder(order), '承認済みで有効な注文を選んでください。');
      }
      state.requests.set(event.requestId, { ...event, answer: '', finished: false, targetQuantity: Number(event.quantity || 0) });
      return;
    }

    if (event.type === 'reply') {
      requireThat(request && request.orderId === order.id && !request.answer, '該当する未回答の依頼がありません。');
      const approved = event.decision === '承認';
      if (approved && request.type !== 'order') {
        requireThat(availableOrder(order), 'キャンセル済みの注文は承認できません。');
      }
      if (approved && request.type === 'change') {
        requireThat(!order.initialFinished, '当初分の製造完了後は注文変更を承認できません。');
        order.paper = request.paper;
        order.quantity = Number(request.quantity);
        state.requests.get(order.originalRequestId).targetQuantity = order.quantity;
      }
      if (approved && request.type === 'cancel') {
        requireThat(!order.initialFinished, '当初分の製造完了後はキャンセルを承認できません。');
        order.cancelled = true;
      }
      if (approved && request.type === 'order') order.approved = true;
      if (approved && ['order', 'change'].includes(request.type)) {
        order.dueDate = event.confirmedDueDate || request.dueDate;
      }
      request.answer = event.decision;
      request.confirmedDueDate = event.confirmedDueDate || request.dueDate || '';
      request.answerReason = event.reason;
      return;
    }

    requireThat(availableOrder(order), '承認済みで有効な注文を選んでください。');
    switch (event.type) {
      case 'proof': {
        requireThat(!proof, '校正IDが重複しています。');
        const previous = [...state.proofs.values()].filter(item => item.orderId === order.id).at(-1);
        requireThat(!previous || (previous.answer === '修正依頼' && Number(event.version) > Number(previous.version)),
          '前の校正に修正依頼があり、版番号が上がっていることを確認してください。');
        state.proofs.set(event.proofId, { ...event, answer: '' });
        order.proofStatus = '回答待ち（第' + event.version + '版）';
        break;
      }
      case 'proofReply':
        requireThat(proof && proof.orderId === order.id && !proof.answer, '該当する回答待ちの校正がありません。');
        proof.answer = event.proofDecision;
        proof.comment = event.comment;
        order.proofStatus = event.proofDecision + '（第' + proof.version + '版）';
        break;
      case 'progress':
        if (!order.progressAt || Date.parse(event.updatedAt) >= Date.parse(order.progressAt)) {
          order.progressAt = event.updatedAt;
          order.progress = event.stage;
          order.expectedDate = event.expectedDate;
        }
        break;
      case 'delay':
        order.delayReason = event.reason;
        order.expectedDate = event.expectedDate;
        break;
      case 'finish':
        requireThat(request && request.orderId === order.id && ['order', 'additional'].includes(request.type) &&
          request.answer === '承認' && !request.finished, '承認済みで未完了の製造依頼を選んでください。');
        requireThat(!order.proofStatus || order.proofStatus.startsWith('承認'), '校正の承認を確認してください。');
        requireThat(Number(event.goodQuantity) + Number(event.shortageQuantity) === request.targetQuantity,
          '良品部数と不足部数の合計を対象依頼の部数に合わせてください。');
        request.finished = true;
        request.goodQuantity = Number(event.goodQuantity);
        request.shortageQuantity = Number(event.shortageQuantity);
        request.completedDate = event.completedDate;
        order.goodQuantity += request.goodQuantity;
        if (request.type === 'order') order.initialFinished = true;
        break;
    }
  }

  function eventValues(event) {
    return ['eventId', 'type', ...interfaces[event.type].fields].map(field => event[field]);
  }

  function buildState(events) {
    const state = { orders: new Map(), requests: new Map(), proofs: new Map() };
    const seen = new Map();
    for (const event of events) {
      requireThat(!seen.has(event.eventId), '台帳内でイベントIDが重複しています。');
      applyEvent(state, event);
      seen.set(event.eventId, event);
    }
    return { ...state, seen };
  }

  function mergeEvents(current, incoming) {
    const state = buildState(current);
    const accepted = [];
    let skipped = 0;
    for (const [index, event] of incoming.entries()) {
      try {
        validateEvent(event);
        const old = state.seen.get(event.eventId);
        if (old) {
          requireThat(JSON.stringify(eventValues(old)) === JSON.stringify(eventValues(event)),
            '同じイベントIDに異なる内容があります。');
          skipped++;
          continue;
        }
        applyEvent(state, event);
        state.seen.set(event.eventId, event);
        accepted.push(event);
      } catch (error) {
        throw new Error('データ ' + (index + 1) + ' 件目：' + error.message);
      }
    }
    return { events: [...current, ...accepted], accepted: accepted.length, skipped };
  }

  function encodeCsv(rows) {
    return '\uFEFF' + rows.map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"')
      .join(',')).join('\r\n') + '\r\n';
  }

  function decodeCsv(text) {
    const input = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let closed = false;

    function pushField() {
      row.push(field);
      field = '';
      closed = false;
    }

    function pushRow() {
      pushField();
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    }

    for (let index = 0; index < input.length; index++) {
      const character = input[index];
      if (quoted) {
        if (character === '"' && input[index + 1] === '"') {
          field += '"';
          index++;
        } else if (character === '"') {
          quoted = false;
          closed = true;
        } else {
          field += character;
        }
      } else if (character === ',') {
        pushField();
      } else if (character === '\r' || character === '\n') {
        if (character === '\r' && input[index + 1] === '\n') index++;
        pushRow();
      } else if (character === '"') {
        requireThat(!closed && !field, 'CSVの引用符の位置が不正です。');
        quoted = true;
      } else {
        requireThat(!closed, 'CSVの閉じ引用符の後に不正な文字があります。');
        field += character;
      }
    }
    requireThat(!quoted, 'CSVの引用符が閉じていません。');
    if (row.length || field || closed) pushRow();
    return rows;
  }

  function exportExchange(type, events) {
    return encodeCsv([['eventId', 'type', ...interfaces[type].fields], ...events.map(eventValues)]);
  }

  function readExchange(text, receivingDepartment) {
    const [header, ...rows] = decodeCsv(text);
    requireThat(rows.length, 'CSVにデータ行がありません。');
    const type = rows[0][1];
    const definition = Object.hasOwn(interfaces, type) && interfaces[type];
    requireThat(definition && definition.from !== receivingDepartment, '相手部署から受信する種類のCSVを選んでください。');
    const expected = ['eventId', 'type', ...definition.fields];
    requireThat(JSON.stringify(header) === JSON.stringify(expected), 'CSVの見出しが仕様と一致しません。');
    return rows.map((row, index) => {
      requireThat(row.length === header.length && row[1] === type, 'データ ' + (index + 1) + ' 件目の列数または種類が不正です。');
      return Object.fromEntries(header.map((field, position) => [field, row[position]]));
    });
  }

  function exportBackup(department, events) {
    return encodeCsv([['department', 'event'], ...events.map(event => [department, JSON.stringify(event)])]);
  }

  function readBackup(department, text) {
    const [header, ...rows] = decodeCsv(text);
    requireThat(JSON.stringify(header) === '["department","event"]', '台帳保存用のCSVを選んでください。');
    const events = rows.map(row => {
      requireThat(row.length === 2 && row[0] === department, '自部署で保存した台帳を選んでください。');
      return JSON.parse(row[1]);
    });
    buildState(events);
    return events;
  }

  globalThis.PrintWorkflow = { interfaces, stages, availableOrder, buildState, mergeEvents,
    exportExchange, readExchange, exportBackup, readBackup };
})();