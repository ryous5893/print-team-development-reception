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
      if (Object.hasOwn(draft, input.name)) {
        input.value = draft[input.name];
        input.dispatchEvent(new Event('input'));
      }
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
    if (field === 'paper') input.setAttribute('list', 'paper-options');
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
      if (field === 'product') {
        const limit = 100;
        const count = element('span');
        count.id = 'product-length';
        count.className = 'hint';
        count.setAttribute('aria-live', 'polite');
        input.setAttribute('aria-describedby', count.id);
        const updateCount = () => {
          const length = [...input.value].length;
          count.textContent = length + ' / ' + limit + '文字' + (length > limit ? '（目安を超えています）' : '');
          count.classList.toggle('attention', length > limit);
        };
        input.addEventListener('input', updateCount);
        updateCount();
        label.append(count);
      }
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
    $('last-export').textContent = '最後に書き出したCSV：' + name;
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

  const orderPageSize = 25;
  let orderPage = 1;

  function renderOrders() {
    const list = $('orders');
    list.replaceChildren();
    const matching = [...state.orders.values()].reverse().filter(order => orderFilters.every(filter => filter(order)));
    const pageCount = Math.max(1, Math.ceil(matching.length / orderPageSize));
    orderPage = Math.min(orderPage, pageCount);
    const start = (orderPage - 1) * orderPageSize;
    for (const order of matching.slice(start, start + orderPageSize)) {
      const row = element('tr');
      const values = [order.id, order.product, order.paper, order.quantity + '部', order.dueDate,
        statusOf(order), order.proofStatus || '—', order.expectedDate || '—',
        order.delayReason || '—', order.initialFinished || order.goodQuantity ? order.goodQuantity + '部' : '—'];
      row.append(...values.map(value => element('td', value)));
      if (order.delayReason) {
        const source = events.find(event => event.type === 'order' && event.orderId === order.id);
        const editor = element('details');
        editor.append(element('summary', '顧客向け遅延連絡'));
        const message = element('textarea');
        message.value = source.salesDelayContact?.message ?? '';
        const messageLabel = element('label', '顧客へ伝えた内容');
        messageLabel.append(message);
        const save = element('button', '保存');
        save.type = 'button';
        save.addEventListener('click', () => {
          if (!message.reportValidity()) return;
          source.salesDelayContact = { message: message.value.trim() };
          hasUnsavedChanges = true;
          show('注文 ' + order.id + ' の顧客向け遅延連絡を台帳に記録しました。');
        });
        editor.append(messageLabel, save);
        row.children[8].append(editor);
      }
      const copyId = element('button', 'IDをコピー');
      copyId.type = 'button';
      copyId.className = 'secondary';
      copyId.setAttribute('aria-label', '注文ID ' + order.id + ' をコピー');
      copyId.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(order.id);
          show('注文ID ' + order.id + ' をコピーしました。');
        } catch {
          show('コピーできませんでした。注文IDを選択して手動でコピーしてください。', true);
        }
      });
      row.children[0].append(copyId);
      const print = element('button', '注文票を印刷');
      print.type = 'button';
      print.className = 'secondary';
      print.addEventListener('click', () => printOrder(order));
      row.children[0].append(print);
      const product = element('details');
      product.className = 'order-product';
      const title = element('summary', order.product);
      title.title = order.product;
      product.append(title, element('p', order.product));
      row.children[1].firstChild.replaceWith(product);
      {
      const source = events.find(event => event.type === 'order' && event.orderId === order.id);
      const editor = element('details');
      editor.append(element('summary', '顧客の連絡先'));
      const phone = element('input');
      phone.type = 'tel';
      phone.value = source.salesCustomer?.phone ?? '';
      const phoneLabel = element('label', '電話番号');
      phoneLabel.append(phone);
      const email = element('input');
      email.type = 'email';
      email.value = source.salesCustomer?.email ?? '';
      const emailLabel = element('label', 'メールアドレス');
      emailLabel.append(email);
      const save = element('button', '保存');
      save.type = 'button';
      save.addEventListener('click', () => {
        if (!phone.reportValidity() || !email.reportValidity()) return;
        source.salesCustomer = { phone: phone.value.trim(), email: email.value.trim() };
        hasUnsavedChanges = true;
        show('注文 ' + order.id + ' の顧客の連絡先を台帳に記録しました。');
      });
      editor.append(phoneLabel, emailLabel, save);
      row.children[1].append(editor);
      }
      const status = statusOf(order);
      const badge = element('span', status);
      const colors = {
        'キャンセル済み': 'neutral', '製造依頼却下': 'danger', '製造承認待ち': 'waiting',
        '製造承認済み': 'progress', '準備中': 'progress', '印刷中': 'progress',
        '加工中': 'progress', '検品中': 'progress', '完了・不足あり': 'waiting', '完了': 'done'
      };
      badge.className = 'order-status order-status--' + (colors[status] || 'neutral');
      row.children[5].firstChild.replaceWith(badge);
      const approvedRequest = [...state.requests.values()].filter(request => request.orderId === order.id &&
        ['order', 'change'].includes(request.type) && request.answer === '承認' && !request.superseded).at(-1);
      if (approvedRequest) {
        const difference = Math.round((Date.parse(approvedRequest.confirmedDueDate) - Date.parse(approvedRequest.dueDate)) / 86400000);
        const comparison = element('p', '希望 ' + approvedRequest.dueDate + ' → 確定 ' + approvedRequest.confirmedDueDate +
          '（' + (difference > 0 ? '+' : '') + difference + '日）');
        if (difference) comparison.className = 'attention';
        row.children[4].append(comparison);
      }
      list.append(row);
    }
    if (!list.children.length) rowMessage(list, 10, '注文がありません。');
    $('order-count').textContent = matching.length + '件該当 ／ 全' + state.orders.size + '件';
    $('order-page').textContent = orderPage + ' / ' + pageCount + 'ページ';
    $('orders-prev').disabled = orderPage === 1;
    $('orders-next').disabled = orderPage === pageCount;
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
      if (event.type === 'reply' && state.requests.get(event.requestId)?.superseded) {
        detail.append(element('p', '古い変更の承認のため、現在の注文は上書きしていません。'));
      }
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
    const item = { eventId: identifier('EV'), type, ...data };
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
    try {
      const text = await file.text();
      const receivedAt = new Date().toISOString();
      const incoming = workflow.readExchange(text, department);
      const previous = new Map(events.map(item => [item.eventId, item]));
      const result = workflow.mergeEvents(events, incoming.map(item => ({ ...item, receivedAt })));
      const duplicateDates = [...new Set(incoming
        .filter(item => previous.has(item.eventId))
        .map(item => {
          const value = previous.get(item.eventId).receivedAt;
          return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ja-JP') : '記録なし';
        }))];
      events = result.events;
      if (result.accepted > 0) hasUnsavedChanges = true;
      refresh();
      show(file.name + ' を取り込みました。新規 ' + result.accepted + ' 件、取り込み済み ' + result.skipped + ' 件。' +
        (duplicateDates.length ? ' 前回取り込み：' + duplicateDates.join('、') : ''));
    } catch (error) {
      show('取り込みを中止しました。' + error.message, true);
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
      const saved = workflow.readBackup(department, await file.text());
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

  orderFilters.push(order => !$('due-today').checked || order.dueDate === localDate());
  $('due-today').addEventListener('change', renderOrders);

  let previousDate = localDate();
  function updateTodayFilter() {
    const today = localDate();
    if (today === previousDate) return;
    previousDate = today;
    if ($('due-today').checked) renderOrders();
  }
  window.addEventListener('focus', updateTodayFilter);
  setInterval(updateTodayFilter, 1000);

  $('orders-prev').addEventListener('click', () => { orderPage--; renderOrders(); });
  $('orders-next').addEventListener('click', () => { orderPage++; renderOrders(); });
  $('order-filters').addEventListener('change', () => {
    if (orderPage === 1) return;
    orderPage = 1;
    renderOrders();
  });

  function printOrder(order) {
    const sheet = $('print-order-sheet');
    const details = element('dl');
    const fields = [
      ['注文ID', order.id], ['品名', order.product], ['用紙', order.paper],
      ['部数', order.quantity + '部'], ['納期', order.dueDate], ['状態', statusOf(order)],
      ['校正', order.proofStatus || '—'], ['完了見込み', order.expectedDate || '—']
    ];
    for (const [label, value] of fields) details.append(element('dt', label), element('dd', value));
    sheet.replaceChildren(element('h1', '注文票'), details);
    document.body.classList.add('printing-order');
    try { window.print(); }
    finally { document.body.classList.remove('printing-order'); }
  }

  const guidance = $('csv-types');
  for (const [type, definition] of Object.entries(workflow.interfaces)) {
    const item = element('li', (definition.from === department ? '書き出し' : '取り込み') + ' · ' +
      definition.name + '（' + type + '）');
    guidance.append(item);
  }
  refresh();
})();
