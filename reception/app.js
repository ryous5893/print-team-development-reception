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
  let state = workflow.buildState(events);
  // RQ-074: 出力処理中（ダウンロードの後片付けが終わる2秒間）は送信中として扱い、
  // ボタンの無効化と合わせて二重送信を防ぐ
  const outputGuardMs = 2000;
  let sending = false;
  // RQ-063: 台帳CSVに保存していない更新があるかどうか（ある間だけ離脱時に警告する）
  let unsaved = false;
  // RQ-088: 台帳を開く直前の台帳（戻し先）。{ events, unsaved } を丸ごと退避する
  let previousLedger = null;
  // RQ-106: 最後にフォーカス／入力した欄を覚えておき、CSV取り込み後に編集へ復帰できるようにする
  let lastFieldFocus = { name: '', selectionStart: null, selectionEnd: null };
  function isTextLike(el) {
    return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'));
  }
  function markUnsaved() {
    unsaved = true;
    // 新しい更新が入ったら台帳保存の内容が変わるので、RQ-074の二重押しガード中でも
    // 保存ボタンをすぐ押せる状態に戻す（savingBackup等は下で宣言されるが、呼ばれるのは初期化後）
    if (savingBackup) {
      savingBackup = false;
      clearTimeout(savingBackupTimer);
      $('save-backup').disabled = false;
    }
  }

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
    // RQ-037: 訂正の対象は、完了済みの依頼がある注文だけを出す
    if (type === 'finishCorrection') {
      return orders.filter(order => [...state.requests.values()].some(request =>
        request.orderId === order.id && ['order', 'additional'].includes(request.type) &&
        request.answer === '承認' && request.finished));
    }
    return orders.filter(workflow.availableOrder);
  }

  function requestChoices(type, order) {
    return [...state.requests.values()]
      .filter(request => order && request.orderId === order.id)
      .filter(request => type === 'reply' ? !request.answer :
        // RQ-037: 訂正は完了済みの依頼だけ、通常の完了報告は未完了の依頼だけを対象にする
        type === 'finishCorrection' ? ['order', 'additional'].includes(request.type) && request.answer === '承認' && request.finished :
        ['order', 'additional'].includes(request.type) && request.answer === '承認' && !request.finished)
      .map(request => [request.requestId, workflow.interfaces[request.type].name + ' · ' +
        (type === 'finish' || type === 'finishCorrection' ? request.targetQuantity + '部 · ' : '') + request.requestId]);
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
      return select(field, orderChoices(type).map(item => [item.id, item.product + ' · ' + item.id]));
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
    $('save-event').disabled = sending || (type !== 'order' && orderChoices(type).length === 0);
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
    // RQ-035: キャンセル依頼が回答待ちの間は、「製造承認済み」等に埋もれさせず一覧で分かるようにする
    const cancelPending = [...state.requests.values()].some(item =>
      item.orderId === order.id && item.type === 'cancel' && !item.answer);
    if (cancelPending) return 'キャンセル回答待ち';
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

  function renderOrders() {
    const list = $('orders');
    list.replaceChildren();
    for (const order of [...state.orders.values()].reverse()) {
      const row = element('tr');
      const values = [order.id, order.product, order.paper, order.quantity + '部', order.dueDate,
        statusOf(order), order.proofStatus || '—', order.expectedDate || '—',
        order.delayReason || '—', order.initialFinished || order.goodQuantity ? order.goodQuantity + '部' : '—'];
      row.append(...values.map(value => element('td', value)));
      list.append(row);
    }
    if (!list.children.length) rowMessage(list, 10, '注文がありません。');
    $('order-count').textContent = state.orders.size + '件';
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
      // RQ-005: 古い変更の承認を上書きしなかった場合は、その旨を履歴の内容に残す
      const repliedRequest = event.type === 'reply' ? state.requests.get(event.requestId) : null;
      if (repliedRequest && repliedRequest.superseded) {
        metadata.append(element('dt', '適用'),
          element('dd', repliedRequest.supersededNote || '後に受け付けた変更が承認済みのため、この承認では上書きしませんでした。'));
      }
      detail.append(metadata);
      const detailCell = element('td');
      detailCell.append(detail);
      const actionCell = element('td');
      if (sent) {
        const button = element('button', 'CSVを書き出す');
        button.type = 'button';
        button.className = 'secondary';
        // RQ-074: 再出力も処理中はボタンを無効化し、連続クリックでも1回だけ書き出す
        let outputting = false;
        button.addEventListener('click', () => {
          if (outputting) return;
          outputting = true;
          button.disabled = true;
          eventDownload(event);
          setTimeout(() => { outputting = false; button.disabled = false; }, outputGuardMs);
        });
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

  // RQ-085: 操作種類ごとの記入途中の内容（種類を切り替えて戻ってきた時に復元する）
  const formDrafts = new Map();

  // RQ-106: 再描画で編集中の入力が消えないよう、フォームの内容を退避／復元する
  function captureFormInput() {
    const values = {};
    for (const el of $('fields').querySelectorAll('input, select, textarea')) {
      if (el.name) values[el.name] = el.value;
    }
    const active = document.activeElement;
    const activeInFields = active && $('fields').contains(active) && active.name ? active : null;
    let selectionStart = null;
    let selectionEnd = null;
    if (activeInFields && isTextLike(activeInFields)) {
      try { selectionStart = activeInFields.selectionStart; selectionEnd = activeInFields.selectionEnd; } catch {}
    }
    return {
      type: $('operation').value, values,
      activeName: activeInFields ? activeInFields.name : lastFieldFocus.name,
      selectionStart: activeInFields ? selectionStart : lastFieldFocus.selectionStart,
      selectionEnd: activeInFields ? selectionEnd : lastFieldFocus.selectionEnd
    };
  }

  function restoreFormInput(snapshot) {
    if (!snapshot || snapshot.type !== $('operation').value) return;
    // 注文に紐づく選択肢（依頼・校正）は、選択中だった注文でフォームを作り直してから値を戻す
    renderForm(snapshot.values.orderId || '');
    for (const el of $('fields').querySelectorAll('input, select, textarea')) {
      if (!el.name || !(el.name in snapshot.values)) continue;
      const value = snapshot.values[el.name];
      if (el.tagName === 'SELECT') {
        // 取り込みで選択肢がなくなったものは無理に戻さない
        if ([...el.options].some(option => option.value === value)) el.value = value;
      } else {
        el.value = value;
      }
    }
    if (snapshot.activeName) {
      const target = $('fields').querySelector('[name="' + snapshot.activeName + '"]');
      if (target) {
        target.focus();
        if (isTextLike(target) && snapshot.selectionStart !== null) {
          try { target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd); } catch {}
        }
        lastFieldFocus = { name: snapshot.activeName, selectionStart: snapshot.selectionStart, selectionEnd: snapshot.selectionEnd };
      }
    }
  }

  function refresh() {
    state = workflow.buildState(events);
    renderOrders();
    renderHistory();
    renderForm();
  }

  $('operation').append(...outgoing.map(([type, definition]) => option(type, definition.name)));
  let currentKind = $('operation').value;
  $('operation').addEventListener('change', () => {
    // RQ-085: 切り替える前に今の種類の記入途中を退避し、戻ってきた種類の下書きがあれば復元する。
    // change発火時点ではセレクトの値は既に新しい種類なので、退避の記録は直前の種類で行う
    const before = captureFormInput();
    before.type = currentKind;
    formDrafts.set(currentKind, before);
    renderForm();
    currentKind = $('operation').value;
    const draft = formDrafts.get(currentKind);
    if (draft) restoreFormInput(draft);
  });

  // RQ-106: 編集中の欄とカーソル位置を記録しておく（ファイル選択でフォーカスが移っても戻せるように）
  $('fields').addEventListener('focusin', event => {
    if (event.target.name) lastFieldFocus = { name: event.target.name, selectionStart: null, selectionEnd: null };
  });
  $('fields').addEventListener('input', event => {
    if (isTextLike(event.target) && event.target.name) {
      try {
        lastFieldFocus = { name: event.target.name, selectionStart: event.target.selectionStart, selectionEnd: event.target.selectionEnd };
      } catch {}
    }
  });

  $('entry').addEventListener('submit', event => {
    event.preventDefault();
    // RQ-074: 処理中は再入させない（ボタンの無効化だけに頼らず、送信イベント自体も止める）
    if (sending) return;
    sending = true;
    $('save-event').disabled = true;
    try {
      const type = $('operation').value;
      const data = Object.fromEntries(new FormData($('entry')));
      const item = { eventId: identifier('EV'), type, ...data };
      if (type === 'order') item.orderId = identifier('ORD');
      if (['order', 'change', 'cancel', 'additional'].includes(type)) item.requestId = identifier('REQ');
      if (type === 'proof') item.proofId = identifier('PRF');
      // RQ-055: 進捗と遅延は通知日時（updatedAt）を新旧判定に使うので、どちらも自動で付ける
      if (type === 'progress' || type === 'delay') item.updatedAt = new Date().toISOString();

      events = workflow.mergeEvents(events, [item]).events;
      markUnsaved();
      refresh();
      // RQ-085: 登録が完了した種類の下書きは破棄する（次に戻ってきても復元されない）
      formDrafts.delete(type);
      eventDownload(item);
      show(workflow.interfaces[type].name + 'を登録し、CSVを書き出しました。');
      // 成功時は処理中扱いを続け、時間が経ったら通常の有効／無効の状態へ戻す
      setTimeout(() => {
        sending = false;
        const currentType = $('operation').value;
        $('save-event').disabled = currentType !== 'order' && orderChoices(currentType).length === 0;
      }, outputGuardMs);
    } catch (error) {
      // 失敗時はすぐ再操作できるように戻す（入力内容はそのまま残る）
      sending = false;
      $('save-event').disabled = false;
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
      const result = workflow.mergeEvents(events, workflow.readExchange(text, department));
      events = result.events;
      // 新規に取り込んだ分がある時だけ未保存にする（取り込み済みの再取り込みでは変えない）
      if (result.accepted > 0) markUnsaved();
      // RQ-106: 再描画の直前に入力を退避し、描画後に戻して編集を続けられるようにする
      const snapshot = captureFormInput();
      refresh();
      restoreFormInput(snapshot);
      show(file.name + ' を取り込みました。新規 ' + result.accepted + ' 件、取り込み済み ' + result.skipped + ' 件。');
    } catch (error) {
      show('取り込みを中止しました。' + error.message, true);
    } finally {
      input.disabled = false;
      input.value = '';
    }
  });

  // RQ-074: 台帳の保存ボタンも、処理中は無効化して連続クリックで重ねて書き出さない
  // ただし RQ-063: 前回の保存後に新しい更新があった場合は、間隔が短くても保存できるようにする
  let savingBackup = false;
  let savingBackupTimer = null;
  $('save-backup').addEventListener('click', () => {
    if (savingBackup && !unsaved) return;
    savingBackup = true;
    $('save-backup').disabled = true;
    unsaved = false;
    download(department + '-backup-' + localDate() + '.csv', workflow.exportBackup(department, events));
    show('台帳を保存しました。再開時は「台帳を開く」を使ってください。');
    clearTimeout(savingBackupTimer);
    savingBackupTimer = setTimeout(() => { savingBackup = false; $('save-backup').disabled = false; }, outputGuardMs);
  });

  $('backup').addEventListener('change', async event => {
    const input = event.target;
    const file = input.files[0];
    if (!file) return;
    try {
      const saved = workflow.readBackup(department, await file.text());
      // RQ-044: 入れ替える直前に、対象ファイル名と件数を必ず確認する（現在の台帳が空でも出す）。
      // キャンセルした場合は現在の台帳をそのまま保持する。
      const orderCount = workflow.buildState(saved).orders.size;
      const message = '台帳を入れ替えますか？\n\n' +
        '対象ファイル：' + file.name + '\n' +
        '件数：記録 ' + saved.length + ' 件（注文 ' + orderCount + ' 件）\n' +
        '現在の台帳：記録 ' + events.length + ' 件\n\n' +
        '現在の台帳は、対象ファイルの内容に置き換わります。';
      if (!confirm(message)) return;
      // RQ-088: 置き換える直前の台帳を退避しておき、誤って開いた場合に戻れるようにする
      previousLedger = { events: [...events], unsaved };
      events = saved;
      // 開いた台帳はファイルの内容そのものなので、未保存の更新はない状態になる
      unsaved = false;
      refresh();
      updateRestoreButton();
      show('保存済みの台帳を開きました。' + file.name + '（記録 ' + saved.length + ' 件）');
    } catch (error) {
      show('台帳を開けませんでした。' + error.message, true);
    } finally {
      input.value = '';
    }
  });

  // RQ-088: 「直前の台帳に戻す」ボタンを台帳の保存・再開の欄に追加する（app.js側で足すので両部署の画面で使える）
  const restoreButton = element('button', '直前の台帳に戻す');
  restoreButton.type = 'button';
  restoreButton.className = 'secondary';
  restoreButton.disabled = true;
  $('backup').closest('section').append(restoreButton);
  function updateRestoreButton() {
    restoreButton.disabled = !previousLedger;
  }
  restoreButton.addEventListener('click', () => {
    if (!previousLedger) return;
    const message = '直前の台帳に戻しますか？\n\n' +
      '戻す台帳：記録 ' + previousLedger.events.length + ' 件\n' +
      '現在の台帳：記録 ' + events.length + ' 件\n\n' +
      '現在の台帳は置き換わります。開いたファイルは、再度「台帳を開く」から読み込めます。';
    if (!confirm(message)) return;
    // 現在の台帳も退避し直すので、もう一度押せば開いた台帳へも行き来できる
    const current = { events: [...events], unsaved };
    events = previousLedger.events;
    unsaved = previousLedger.unsaved;
    previousLedger = current;
    refresh();
    show('直前の台帳に戻しました。');
  });

  // RQ-063: 未保存の更新がある間だけ、閉じる／再読み込みの前にブラウザの確認を出す。
  // 保存済み・変更なしの場合は何もしない（警告しない）。
  window.addEventListener('beforeunload', event => {
    if (!unsaved) return;
    event.preventDefault();
    event.returnValue = '';
  });

  const guidance = $('csv-types');
  for (const [type, definition] of Object.entries(workflow.interfaces)) {
    const item = element('li', (definition.from === department ? '書き出し' : '取り込み') + ' · ' +
      definition.name + '（' + type + '）');
    guidance.append(item);
  }
  refresh();
})();