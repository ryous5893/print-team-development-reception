(function () {
  'use strict';

  const workflow = PrintWorkflow;
  const department = document.body.dataset.department;
  const $ = id => document.getElementById(id);
  const outgoing = Object.entries(workflow.interfaces).filter(([, definition]) => definition.from === department);
  const fields = {
    orderId: ['注文ID'], requestId: ['依頼ID'], proofId: ['校正ID'],
    product: ['品名'], paper: ['用紙'], quantity: ['部数', 'number'],
    dueDate: ['希望納期', 'date'], reason: ['理由'], version: ['版番号', 'number'],
    instruction: ['確認事項'], responseDueDate: ['回答期限', 'date'],
    proofDecision: ['校正回答', ['承認', '修正依頼']], comment: ['修正コメント'],
    decision: ['依頼回答', ['承認', '却下']], confirmedDueDate: ['確定納期', 'date'],
    stage: ['工程', workflow.stages], expectedDate: ['完了見込み日', 'date'],
    completedDate: ['完成日', 'date'], goodQuantity: ['良品部数', 'number'],
    shortageQuantity: ['不足部数', 'number']
  };
  let events = [];
  let drafts = [];
  let activeDraftId = '';
  let state = workflow.buildState(events);
  let hasUnsavedChanges = false;
  const formDrafts = new Map();
  let renderedOperation = '';

  function rememberForm() {
    if (renderedOperation) {
      formDrafts.set(renderedOperation, Object.fromEntries(new FormData($('entry'))));
    }
  }

  function restoreForm() {
    const draft = formDrafts.get($('operation').value);
    renderForm(draft?.orderId || '');
    if (!draft) return;
    for (const input of $('fields').querySelectorAll('[name]')) {
      if (Object.hasOwn(draft, input.name)) input.value = draft[input.name];
    }
  }

  window.addEventListener('beforeunload', event => {
    if (!hasUnsavedChanges) return;
    event.preventDefault();
    event.returnValue = '';
  });

  function element(tag, content) {
    const item = document.createElement(tag);
    if (content !== undefined) item.textContent = content;
    return item;
  }

  function option(value, label) {
    const item = element('option', label);
    item.value = value;
    return item;
  }

  function select(name, options) {
    const input = element('select');
    input.name = name;
    const placeholder = option('', options.length ? '選択してください' : '対象データがありません');
    placeholder.disabled = true;
    placeholder.selected = true;
    input.append(placeholder, ...options.map(([value, label]) => option(value, label)));
    return input;
  }

  function show(message, error = false) {
    $('message').textContent = message;
    $('message').dataset.error = String(error);
  }

  function csvKind(text) {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
    const header = lines[0].replaceAll('"', '');
    if (header === 'department,event') {
      try { workflow.readBackup(department, text); return '自部署の台帳CSV（「台帳を開く」用）'; }
      catch { return '台帳CSV（部署・内容を確認してください）'; }
    }
    if (header.startsWith('eventId,type,')) {
      const type = (lines[1] || '').split(',')[1]?.replaceAll('"', '');
      const definition = Object.hasOwn(workflow.interfaces, type) && workflow.interfaces[type];
      if (definition) return (definition.from === department ? '自部署から送る' : '相手部署からの') + definition.name + 'CSV';
    }
    return '形式不明のCSV';
  }

  function localDate() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }

  function identifier(prefix) {
    return prefix + '-' + Array.from(crypto.getRandomValues(new Uint32Array(3)), number =>
      number.toString(36).padStart(7, '0')).join('');
  }

  function orderChoices(type) {
    const orders = [...state.orders.values()];
    if (type === 'reply') {
      return orders.filter(order => [...state.requests.values()].some(request =>
        request.orderId === order.id && !request.answer));
    }
    return orders.filter(workflow.availableOrder);
  }

  function requestChoices(type, order) {
    return [...state.requests.values()]
      .filter(request => order && request.orderId === order.id)
      .filter(request => type === 'reply' ? !request.answer :
        ['order', 'additional'].includes(request.type) && request.answer === '承認' && !request.finished)
      .map(request => [request.requestId, workflow.interfaces[request.type].name + ' · ' +
        (type === 'finish' ? request.targetQuantity + '部 · ' : '') + request.requestId]);
  }

  function proofChoices(order) {
    return [...state.proofs.values()].filter(proof => order && proof.orderId === order.id && !proof.answer)
      .map(proof => [proof.proofId, '第' + proof.version + '版 · ' + proof.instruction]);
  }

  function automaticField(type, field) {
    return field === 'updatedAt' || (type === 'order' && field === 'orderId') ||
      (['order', 'change', 'cancel', 'additional'].includes(type) && field === 'requestId') ||
      (type === 'proof' && field === 'proofId');
  }

  function inputFor(type, field, order) {
    const [, kind] = fields[field];
    if (field === 'orderId') {
      return select(field, orderChoices(type).map(item => [item.id,
        item.product + ' · ' + item.quantity + '部 · 納期 ' + item.dueDate + ' · ' + item.id]));
    }
    if (field === 'requestId') return select(field, requestChoices(type, order));
    if (field === 'proofId') return select(field, proofChoices(order));
    if (Array.isArray(kind)) return select(field, kind.map(value => [value, value]));

    const input = element(field === 'comment' || field === 'instruction' ? 'textarea' : 'input');
    input.name = field;
    if (input.tagName === 'INPUT') input.type = kind || 'text';
    if (input.type === 'number') {
      input.min = ['goodQuantity', 'shortageQuantity'].includes(field) ? '0' : '1';
      input.step = '1';
    }
    if (field === 'completedDate') input.value = localDate();
    if (field === 'version') {
      const last = [...state.proofs.values()].filter(proof => order && proof.orderId === order.id).at(-1);
      input.value = last ? Number(last.version) + 1 : 1;
    }
    if (type === 'change' && order && ['paper', 'quantity', 'dueDate'].includes(field)) {
      input.value = order[field];
    }
    return input;
  }

  function renderForm(selectedOrder = '') {
    const type = $('operation').value;
    renderedOperation = type;
    const definition = workflow.interfaces[type];
    const order = state.orders.get(selectedOrder);
    const formFields = $('fields');
    formFields.replaceChildren();

    for (const field of definition.fields) {
      if (automaticField(type, field)) continue;
      const label = element('label');
      const input = inputFor(type, field, order);
      input.required = !['comment', 'confirmedDueDate'].includes(field) &&
        !(field === 'reason' && type === 'reply');
      if (field === 'orderId' && selectedOrder) input.value = selectedOrder;
      if (field === 'orderId') input.addEventListener('change', () => {
        renderForm(input.value);
        formFields.querySelector('[name="orderId"]').focus();
      });
      label.append(element('span', fields[field][0] + (input.required ? ' *' : '')), input);
      formFields.append(label);
    }
    $('action-help').textContent = type === 'order' ? '注文IDと依頼IDは自動で発行します。' :
      '対象の注文を選択してください。関連する依頼や校正は注文を選ぶと表示されます。';
    $('save-event').disabled = type !== 'order' && orderChoices(type).length === 0;
    $('save-draft').hidden = type !== 'order';
  }

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = element('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function eventDownload(event) {
    download(event.type + '-' + event.orderId + '-' + event.eventId + '.csv',
      workflow.exportExchange(event.type, [event]));
  }

  function statusOf(order) {
    const request = state.requests.get(order.originalRequestId);
    if (order.cancelled) return 'キャンセル済み';
    if (!order.approved) return request.answer === '却下' ? '製造依頼却下' : '製造承認待ち';
    if (order.initialFinished) return order.goodQuantity < order.quantity ? '完了・不足あり' : '完了';
    return order.progress || '製造承認済み';
  }

  function rowMessage(tableBody, columns, message) {
    const row = element('tr');
    const cell = element('td', message);
    cell.colSpan = columns;
    cell.className = 'empty';
    row.append(cell);
    tableBody.append(row);
  }

  const orderFilters = [];

  function renderOrders() {
    const list = $('orders');
    list.replaceChildren();
    for (const order of [...state.orders.values()].reverse()) {
      if (!orderFilters.every(filter => filter(order))) continue;
      const row = element('tr');
      const values = [order.id, order.product, order.paper, order.quantity + '部', order.dueDate,
        statusOf(order), order.proofStatus || '—', order.expectedDate || '—',
        order.delayReason || '—', order.initialFinished || order.goodQuantity ? order.goodQuantity + '部' : '—'];
      row.append(...values.map(value => element('td', value)));
      for (const request of [...state.requests.values()].filter(item => item.orderId === order.id && !item.answer)) {
        const elapsed = request.createdAt && Number.isFinite(Date.parse(request.createdAt)) ?
          Math.max(0, Math.floor((Date.now() - Date.parse(request.createdAt)) / 86400000)) + '日経過' : '依頼日時不明';
        row.children[5].append(element('p', workflow.interfaces[request.type].name + '：未回答 ' + elapsed));
      }
      const approvedRequest = [...state.requests.values()].filter(request => request.orderId === order.id &&
        ['order', 'change'].includes(request.type) && request.answer === '承認' && !request.superseded).at(-1);
      if (approvedRequest) {
        const difference = Math.round((Date.parse(approvedRequest.confirmedDueDate) - Date.parse(approvedRequest.dueDate)) / 86400000);
        const comparison = element('p', '希望 ' + approvedRequest.dueDate + ' → 確定 ' + approvedRequest.confirmedDueDate +
          '（' + (difference > 0 ? '+' : '') + difference + '日）');
        if (difference) comparison.className = 'attention';
        row.children[4].append(comparison);
      }
      const cancellation = [...state.requests.values()].filter(request => request.orderId === order.id && request.type === 'cancel').at(-1);
      if (cancellation) row.children[5].append(element('p', '製造側の取消確認：' +
        (cancellation.answer === '承認' ? '確認済み' : cancellation.answer === '却下' ? '却下' : '確認待ち')));
      const copy = element('button', 'コピーして新規注文');
      copy.type = 'button';
      copy.className = 'secondary';
      copy.addEventListener('click', () => {
        rememberForm();
        if (typeof activeDraftId !== 'undefined') activeDraftId = '';
        $('operation').value = 'order';
        formDrafts.set('order', { product: order.product, paper: order.paper, quantity: String(order.quantity), dueDate: order.dueDate });
        restoreForm();
        $('fields').querySelector('[name="quantity"]').focus();
        show('注文 ' + order.id + ' をコピーしました。部数・希望納期を確認して登録してください。');
      });
      row.children[1].append(copy);
      list.append(row);
    }
    if (!list.children.length) rowMessage(list, 10, '注文がありません。');
    $('order-count').textContent = list.querySelectorAll('tr:not(:has(.empty))').length + '件表示 ／ 全' + state.orders.size + '件';
  }

  function renderHistory() {
    const list = $('history');
    list.replaceChildren();
    for (const event of [...events].reverse()) {
      const definition = workflow.interfaces[event.type];
      const sent = definition.from === department;
      const row = element('tr');
      const detail = element('details');
      detail.append(element('summary', '内容を見る'));
      const metadata = element('dl');
      for (const field of definition.fields) {
        metadata.append(element('dt', fields[field]?.[0] || '更新日時'), element('dd', event[field] || '—'));
      }
      detail.append(metadata);
      const detailCell = element('td');
      detailCell.append(detail);
      const actionCell = element('td');
      if (sent) {
        const button = element('button', 'CSVを書き出す');
        button.type = 'button';
        button.className = 'secondary';
        button.addEventListener('click', () => eventDownload(event));
        actionCell.append(button);
      } else {
        actionCell.textContent = '—';
      }
      row.append(element('td', sent ? '送信側' : '受信側'), element('td', definition.name),
        element('td', event.orderId), detailCell, actionCell);
      list.append(row);
    }
    if (!list.children.length) rowMessage(list, 5, 'やり取りはまだありません。');
  }

  function renderDrafts() {
    const list = $('drafts');
    list.replaceChildren();
    for (const draft of drafts) {
      const row = element('tr');
      row.append(...['下書き', draft.product || '未入力', draft.paper || '未入力',
        draft.quantity ? draft.quantity + '部' : '未入力', draft.dueDate || '未入力']
        .map(value => element('td', value)));
      const action = element('td');
      const edit = element('button', '編集・製造依頼へ');
      edit.type = 'button';
      edit.addEventListener('click', () => {
        rememberForm();
        activeDraftId = draft.id;
        $('operation').value = 'order';
        formDrafts.set('order', draft);
        restoreForm();
        $('fields').querySelector('[name="product"]').focus();
        show('下書きを開きました。内容を確認し、登録すると製造依頼を書き出します。');
      });
      action.append(edit);
      row.append(action);
      list.append(row);
    }
    if (!drafts.length) rowMessage(list, 6, '下書きはありません。');
    $('draft-count').textContent = drafts.length + '件';
  }

  $('save-draft').addEventListener('click', () => {
    if ($('operation').value !== 'order') return;
    const data = Object.fromEntries(new FormData($('entry')));
    const draft = { id: activeDraftId || identifier('DRAFT'), ...data };
    drafts = [...drafts.filter(item => item.id !== draft.id), draft];
    activeDraftId = draft.id;
    hasUnsavedChanges = true;
    renderDrafts();
    show('注文を下書き保存しました。閉じる前に台帳を保存してください。');
  });

  function refresh() {
    state = workflow.buildState(events);
    renderOrders();
    renderHistory();
    renderForm();
    renderDrafts();
  }

  $('operation').append(...outgoing.map(([type, definition]) => option(type, definition.name)));
  $('operation').addEventListener('change', () => {
    rememberForm();
    restoreForm();
  });

  $('entry').addEventListener('submit', event => {
    event.preventDefault();
    const type = $('operation').value;
    const data = Object.fromEntries(new FormData($('entry')));
    if (data.dueDate && data.dueDate < localDate() &&
      !confirm('希望納期 ' + data.dueDate + ' は過去日です。このまま登録しますか？')) return;
    if (type === 'order' && !confirm('製造依頼を登録しますか？\n品名：' + data.product +
      '\n用紙：' + data.paper + '\n部数：' + data.quantity + '部\n希望納期：' + data.dueDate)) return;
    const selectedProof = state.proofs.get(data.proofId);
    if (type === 'proofReply' && selectedProof && !confirm('校正回答を登録しますか？\n注文ID：' +
      data.orderId + '\n品名：' + state.orders.get(data.orderId).product + '\n第' + selectedProof.version +
      '版\n回答：' + data.proofDecision + '\n修正コメント：' + (data.comment || 'なし'))) return;
    const item = { eventId: identifier('EV'), type, ...data, createdAt: new Date().toISOString() };
    if (type === 'order') item.orderId = identifier('ORD');
    if (['order', 'change', 'cancel', 'additional'].includes(type)) item.requestId = identifier('REQ');
    if (type === 'proof') item.proofId = identifier('PRF');
    if (type === 'progress') item.updatedAt = new Date().toISOString();

    try {
      events = workflow.mergeEvents(events, [item]).events;
      if (type === 'order') {
        drafts = drafts.filter(draft => draft.id !== activeDraftId);
        activeDraftId = '';
      }
      hasUnsavedChanges = true;
      formDrafts.delete(type);
      refresh();
      eventDownload(item);
      show(workflow.interfaces[type].name + 'を登録し、CSVを書き出しました。');
    } catch (error) {
      show(error.message, true);
    }
  });

  $('incoming').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    input.disabled = true;
    let kind = '形式不明のCSV';
    try {
      const text = await file.text();
      kind = csvKind(text);
      const result = workflow.mergeEvents(events, workflow.readExchange(text, department));
      events = result.events;
      if (result.accepted > 0) hasUnsavedChanges = true;
      refresh();
      show(file.name + ' を取り込みました。新規 ' + result.accepted + ' 件、取り込み済み ' + result.skipped + ' 件。');
    } catch (error) {
      show('取り込みを中止しました（' + kind + '）。' + error.message, true);
    } finally {
      input.disabled = false;
      input.value = '';
    }
  });

  $('save-backup').addEventListener('click', () => {
    download(department + '-backup-' + localDate() + '.csv', workflow.exportBackup(department, events, drafts));
    hasUnsavedChanges = false;
    show('台帳を保存しました。再開時は「台帳を開く」を使ってください。');
  });

  $('backup').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (!csvKind(text).includes('台帳CSV')) throw new Error(csvKind(text) + 'です。「相手部署からのCSV」に読み込んでください。');
      const saved = workflow.readBackup(department, text);
      const orderCount = workflow.buildState(saved).orders.size;
      if (!confirm('「' + file.name + '」を開きますか？\n注文 ' + orderCount +
        ' 件／履歴 ' + saved.length + ' 件／下書き ' + (saved.drafts?.length || 0) + ' 件\n' +
        (events.length || drafts.length ? '現在の台帳を置き換えます。' : 'この台帳で作業を開始します。'))) return;
      events = saved;
      drafts = saved.drafts || [];
      activeDraftId = '';
      hasUnsavedChanges = false;
      formDrafts.clear();
      refresh();
      show('保存済みの台帳を開きました。');
    } catch (error) {
      show('台帳を開けませんでした。' + error.message, true);
    } finally {
      input.value = '';
    }
  });

  orderFilters.push(order => !$('unanswered-only').checked || [...state.requests.values()].some(request => request.orderId === order.id && !request.answer));
  $('unanswered-only').addEventListener('change', renderOrders);
  orderFilters.push(order => !$('shortage-only').checked || (order.initialFinished && order.goodQuantity < order.quantity));
  $('shortage-only').addEventListener('change', renderOrders);
  orderFilters.push(order => !$('hide-confirmed-cancel').checked || !order.cancelled);
  $('hide-confirmed-cancel').addEventListener('change', renderOrders);
  orderFilters.push(order => $('show-cancelled').checked || !order.cancelled);
  $('show-cancelled').addEventListener('change', renderOrders);
  const guidance = $('csv-types');
  for (const [type, definition] of Object.entries(workflow.interfaces)) {
    const item = element('li', (definition.from === department ? '書き出し' : '取り込み') + ' · ' +
      definition.name + '（' + type + '）');
    guidance.append(item);
  }
  refresh();
})();
