// ===== 定数 =====
const STORAGE_KEY    = 'sift_calendar_v3';
const SETTINGS_KEY   = 'sift_settings_v3';

// ===== スタンプ定義 =====
const STAMPS = {
  work:    { label: '💼 仕事',  bg: 'bg-indigo-500', border: 'border-indigo-600', hover: 'hover:bg-indigo-50 hover:border-indigo-300' },
  holiday: { label: '🏖️ 公休',  bg: 'bg-emerald-500', border: 'border-emerald-600', hover: 'hover:bg-emerald-50 hover:border-emerald-300' },
  errand:  { label: '📝 用事',  bg: 'bg-amber-500',   border: 'border-amber-600',   hover: 'hover:bg-amber-50 hover:border-amber-300' },
};

// ===== state =====
let currentYear  = 2026;
let currentMonth = 6;
let activeStamp  = 'work';

// dayData: { 'YYYY-MM-DD': { stamp, start, end, breakMin, memo } }
let dayData = {};

// settings: デフォルト勤務設定
let settings = {
  wage:     1100,
  defStart: '09:10',
  defEnd:   '17:00',
  defBreak: 60,
};

// ===== ドラッグ選択 state =====
let isDragging        = false;
let isDragPending     = false;
let dragDays          = new Set();
let dragStartDay      = null;
let suppressNextClick = false;
let touchStartX       = 0;
let touchStartY       = 0;
const DRAG_THRESHOLD  = 12;
let longPressTimer    = null;
const LONG_PRESS_MS   = 500;

// ===== ユーティリティ =====
function dateKey(year, month, day) {
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

// 'HH:MM' → 分（整数）
function timeToMin(t) {
  if (!t || !t.includes(':')) return NaN;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// 分 → 'H時間M分' 表示
function minToLabel(min) {
  if (isNaN(min) || min <= 0) return '0h';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

// 1日の実働分を計算（データが揃っていない場合は 0）
function calcWorkMin(entry) {
  if (!entry || entry.stamp !== 'work') return 0;
  const s = timeToMin(entry.start);
  const e = timeToMin(entry.end);
  const b = Number(entry.breakMin) || 0;
  if (isNaN(s) || isNaN(e) || e <= s) return 0;
  return Math.max(0, (e - s) - b);
}

// ===== localStorage =====
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    dayData = raw ? JSON.parse(raw) : {};
    // 旧形式（文字列値）を移行
    Object.keys(dayData).forEach(k => {
      if (typeof dayData[k] === 'string') {
        dayData[k] = { stamp: dayData[k], start: settings.defStart, end: settings.defEnd, breakMin: settings.defBreak, memo: '' };
      }
    });
  } catch (_) { dayData = {}; }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(dayData));
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch (_) {}
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ===== パース（範囲指定対応） =====
function parseDays(text) {
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();
  const result = new Set();
  const rangeRe = /(\d+)\s*[-〜～]\s*(\d+)/g;
  let m;
  while ((m = rangeRe.exec(text)) !== null) {
    const from = Math.min(Number(m[1]), Number(m[2]));
    const to   = Math.max(Number(m[1]), Number(m[2]));
    for (let d = from; d <= to; d++) {
      if (d >= 1 && d <= daysInMonth) result.add(d);
    }
  }
  const stripped = text.replace(/(\d+)\s*[-〜～]\s*(\d+)/g, ' ');
  (stripped.match(/\d+/g) || []).map(Number).forEach(n => {
    if (n >= 1 && n <= daysInMonth) result.add(n);
  });
  return [...result].sort((a, b) => a - b);
}

// ===== ドラッグ確定（2マス目に入った瞬間に開始マスも含めて適用） =====
function startDragConfirmed() {
  if (isDragging) return;
  isDragging = true;
  // 開始マスを適用
  if (dragStartDay !== null) applyDragDay(dragStartDay);
}

// ===== ドラッグ選択：マスに適用 =====
function applyDragDay(d) {
  if (dragDays.has(d)) return;
  dragDays.add(d);
  const key = dateKey(currentYear, currentMonth, d);
  const existing = dayData[key] || {};
  dayData[key] = {
    stamp:    activeStamp,
    start:    existing.start    ?? settings.defStart,
    end:      existing.end      ?? settings.defEnd,
    breakMin: existing.breakMin ?? settings.defBreak,
    memo:     existing.memo     ?? '',
  };
  // リアルタイムでそのマスだけ色更新（色クラスのみ安全に差し替え）
  const cell = document.querySelector(`[data-day="${d}"]`);
  if (cell) {
    // 既存の色・ボーダー系クラスを除去
    const remove = [];
    cell.classList.forEach(c => {
      if (/^(bg-|border-|text-|shadow-|opacity-)/.test(c)) remove.push(c);
    });
    cell.classList.remove(...remove);
    // スタンプ色を追加
    const s = STAMPS[activeStamp];
    cell.classList.add(...`${s.bg} ${s.border} text-white shadow-md`.split(' '));
  }
}

function endDrag() {
  isDragPending = false;
  if (!isDragging) return;
  isDragging = false;
  if (dragDays.size > 0) {
    saveData();
    renderCalendar();
    updateSidebar();
    showToast(`${dragDays.size}日（${STAMPS[activeStamp].label}）を反映しました`);
  }
  dragDays.clear();
  dragStartDay = null;
}

// タッチ座標からカレンダーマスの日を取得
function dayFromTouch(touch) {
  const el = document.elementFromPoint(touch.clientX, touch.clientY);
  const cell = el?.closest('[data-day]');
  return cell ? parseInt(cell.dataset.day, 10) : null;
}

// ===== カレンダー描画 =====
function renderCalendar() {
  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';

  const firstDay    = new Date(currentYear, currentMonth - 1, 1).getDay();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(currentYear, currentMonth, 0).getDate();

  ['月','火','水','木','金','土','日'].forEach((h, i) => {
    const el = document.createElement('div');
    el.className = `flex items-center justify-center h-9 text-xs font-bold rounded ${
      i === 6 ? 'text-red-400 bg-red-50' : i === 5 ? 'text-blue-400 bg-blue-50' : 'text-slate-500 bg-slate-100'
    }`;
    el.textContent = h;
    grid.appendChild(el);
  });

  for (let i = 0; i < startOffset; i++) {
    const el = document.createElement('div');
    el.className = 'rounded';
    grid.appendChild(el);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key     = dateKey(currentYear, currentMonth, d);
    const entry   = dayData[key] || null;
    const stamp   = entry?.stamp || null;
    const stampDef = stamp ? STAMPS[stamp] : null;
    const dow     = (startOffset + d - 1) % 7;
    const isSat   = dow === 5;
    const isSun   = dow === 6;
    const workMin = entry ? calcWorkMin(entry) : 0;

    const el = document.createElement('div');
    let cls = 'day-cell relative flex flex-col items-center justify-start pt-1 rounded-lg border cursor-pointer select-none transition-all duration-150 ';

    if (stampDef) {
      cls += `${stampDef.bg} ${stampDef.border} text-white shadow-md`;
    } else if (isSun) {
      cls += 'bg-red-50 border-red-200 text-red-500 hover:bg-red-100';
    } else if (isSat) {
      cls += 'bg-blue-50 border-blue-200 text-blue-500 hover:bg-blue-100';
    } else {
      cls += `bg-white border-slate-200 text-slate-700 ${STAMPS[activeStamp].hover}`;
    }
    el.className = cls;
    el.dataset.day = d;

    // 日付
    const dayNum = document.createElement('span');
    dayNum.className = 'text-sm font-bold leading-none mt-0.5';
    dayNum.textContent = d;
    el.appendChild(dayNum);

    if (stampDef) {
      // アイコンのみ（ラベルなし）
      const icon = document.createElement('span');
      icon.className = 'text-base leading-none mt-1';
      icon.textContent = stampDef.label.split(' ')[0]; // 絵文字だけ
      el.appendChild(icon);
    }

    // 仕事：実働時間
    if (stamp === 'work' && workMin > 0) {
      const timeLabel = document.createElement('span');
      timeLabel.className = 'text-[10px] leading-none opacity-90 mt-0.5 font-medium';
      timeLabel.textContent = minToLabel(workMin);
      el.appendChild(timeLabel);
    }

    // メモあり：アイコンのみ表示
    if (entry?.memo) {
      const memoIcon = document.createElement('span');
      memoIcon.className = 'text-[10px] leading-none mt-0.5 opacity-80';
      memoIcon.textContent = '📋';
      el.appendChild(memoIcon);
    }

    // 右上バツ印削除ボタン（登録済みの日のみ表示）
    if (entry) {
      const delBtn = document.createElement('button');
      delBtn.className = 'absolute top-0.5 right-0.5 w-4 h-4 flex items-center justify-center rounded-full bg-white/30 hover:bg-white/60 text-white text-[10px] font-bold leading-none transition-colors';
      delBtn.textContent = '×';
      delBtn.title = '削除';
      delBtn.addEventListener('click', e => {
        e.stopPropagation();
        deleteDay(d);
      });
      // スマホ：touchstart で親のtouchstartを止めて削除実行
      delBtn.addEventListener('touchstart', e => {
        e.stopPropagation();
        e.preventDefault();
        deleteDay(d);
      }, { passive: false });
      el.appendChild(delBtn);
    }

    // --- マウス操作 ---
    el.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      isDragPending = true;
      isDragging = false;
      dragDays.clear();
      dragStartDay = d;
      // 長押しタイマー起動
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        isDragPending = false;
        dragStartDay = null;
        openPreview(d);
      }, LONG_PRESS_MS);
    });

    // --- タッチ操作 ---
    el.addEventListener('touchstart', e => {
      isDragPending = true;
      isDragging = false;
      dragDays.clear();
      dragStartDay = d;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      // 長押しタイマー起動
      if (longPressTimer) clearTimeout(longPressTimer);
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        // この時点でまだ指が载っているならプレビューを開く
        if (!isDragging) {
          isDragPending = false;
          dragDays.clear();
          dragStartDay = null;
          suppressNextClick = true;
          openPreview(d);
        }
      }, LONG_PRESS_MS);
    }, { passive: true });

    // touchcancel: コンテキストメニューなどでキャンセルされた場合はタイマーを継続（ドラッグもリセット）
    el.addEventListener('touchcancel', () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      isDragPending = false;
      isDragging = false;
      dragDays.clear();
      dragStartDay = null;
    }, { passive: true });

    // click: PC用タップ（長押し・ドラッグでなければ即入力）
    el.addEventListener('click', () => {
      if (suppressNextClick) { suppressNextClick = false; return; }
    });

    grid.appendChild(el);
  }

  // マウス移動：別マスに入ったらドラッグ確定
  grid.addEventListener('mousemove', e => {
    if (!isDragPending) return;
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    const cell = e.target.closest('[data-day]');
    if (!cell) return;
    const d = parseInt(cell.dataset.day, 10);
    if (d !== dragStartDay) {
      startDragConfirmed();
    }
    if (isDragging) applyDragDay(d);
  });

  // タッチ移動（実際に別マスに入ったときだけドラッグ確定＆タイマーキャンセル）
  grid.addEventListener('touchmove', e => {
    if (!isDragPending) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStartX;
    const dy = t.clientY - touchStartY;
    if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return;
    const moved = dayFromTouch(t);
    if (moved === null || moved === dragStartDay) return;
    // 別マスに入った → 長押しではなくドラッグ確定
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    startDragConfirmed();
    if (isDragging) applyDragDay(moved);
  }, { passive: true });

  // タッチ終了
  grid.addEventListener('touchend', () => {
    if (!isDragPending) return;
    if (longPressTimer !== null) {
      // タイマーがまだ生きている = 短タップ → キャンセルして即入力
      clearTimeout(longPressTimer);
      longPressTimer = null;
      if (!isDragging && dragStartDay !== null) {
        const tappedDay = dragStartDay;
        isDragPending = false;
        dragStartDay = null;
        suppressNextClick = true;
        applyStampSingle(tappedDay);
        return;
      }
    }
    // タイマーが null = 長押し発火済み or ドラッグ中
    if (isDragging) endDrag();
    isDragPending = false;
  });
}

// mouseup はdocument全体で受け取る
document.addEventListener('mouseup', () => {
  if (!isDragPending) return;
  if (longPressTimer !== null) {
    // タイマーまだ生きている = 短クリック → 即入力
    clearTimeout(longPressTimer);
    longPressTimer = null;
    if (!isDragging && dragStartDay !== null) {
      const tappedDay = dragStartDay;
      isDragPending = false;
      dragStartDay = null;
      applyStampSingle(tappedDay);
      return;
    }
  }
  // タイマーが null = 長押し発火済み or ドラッグ中
  if (isDragging) endDrag();
  isDragPending = false;
});

// ===== 1マス即座スタンプ入力 =====
function applyStampSingle(d) {
  const key = dateKey(currentYear, currentMonth, d);
  const existing = dayData[key] || {};
  dayData[key] = {
    stamp:    activeStamp,
    start:    existing.start    ?? settings.defStart,
    end:      existing.end      ?? settings.defEnd,
    breakMin: existing.breakMin ?? settings.defBreak,
    memo:     existing.memo     ?? '',
  };
  saveData();
  renderCalendar();
  updateSidebar();
}

// ===== マス個別削除 =====
function deleteDay(d) {
  const key = dateKey(currentYear, currentMonth, d);
  delete dayData[key];
  saveData();
  renderCalendar();
  updateSidebar();
  showToast(`${d}日の登録を削除しました`);
}

// ===== トグル（モーダルなし用・内部利用） =====
function toggleDay(d, stamp, start, end, breakMin) {
  const key = dateKey(currentYear, currentMonth, d);
  if (dayData[key]?.stamp === stamp && !start) {
    delete dayData[key];
  } else {
    dayData[key] = {
      stamp,
      start:    start    ?? settings.defStart,
      end:      end      ?? settings.defEnd,
      breakMin: breakMin ?? settings.defBreak,
    };
  }
  saveData();
  renderCalendar();
  updateSidebar();
}

// ===== 一括反映 =====
function applyInput() {
  const text = document.getElementById('day-input').value;
  const days = parseDays(text);
  if (days.length === 0) {
    showToast('有効な日付が見つかりませんでした');
    return;
  }
  days.forEach(d => {
    const key = dateKey(currentYear, currentMonth, d);
    // 既存エントリの時間設定・メモは保持しつつスタンプ上書き
    const existing = dayData[key] || {};
    dayData[key] = {
      stamp:    activeStamp,
      start:    existing.start    ?? settings.defStart,
      end:      existing.end      ?? settings.defEnd,
      breakMin: existing.breakMin ?? settings.defBreak,
      memo:     existing.memo     ?? '',
    };
  });
  saveData();
  renderCalendar();
  updateSidebar();
  document.getElementById('day-input').value = '';
  showToast(`${days.length}日（${STAMPS[activeStamp].label}）を反映しました`);
}

// ===== 全クリア（表示月のみ） =====
function clearAll() {
  if (!confirm(`${currentYear}年${currentMonth}月のシフトをすべてクリアしますか？`)) return;
  const prefix = `${currentYear}-${String(currentMonth).padStart(2,'0')}-`;
  Object.keys(dayData).forEach(k => { if (k.startsWith(prefix)) delete dayData[k]; });
  saveData();
  renderCalendar();
  updateSidebar();
}

// ===== サイドバー更新（集計・給与） =====
function updateSidebar() {
  const prefix = `${currentYear}-${String(currentMonth).padStart(2,'0')}-`;
  const monthEntries = Object.entries(dayData).filter(([k]) => k.startsWith(prefix));

  const counts   = { work: 0, holiday: 0, errand: 0 };
  let totalWorkMin = 0;
  monthEntries.forEach(([, v]) => {
    if (counts[v.stamp] !== undefined) counts[v.stamp]++;
    totalWorkMin += calcWorkMin(v);
  });

  const el = id => document.getElementById(id);
  if (el('count-work'))    el('count-work').textContent    = `${counts.work} 日`;
  if (el('count-holiday')) el('count-holiday').textContent = `${counts.holiday} 日`;
  if (el('count-errand'))  el('count-errand').textContent  = `${counts.errand} 日`;

  const h = Math.floor(totalWorkMin / 60);
  const m = totalWorkMin % 60;
  const hoursLabel = m === 0 ? `${h}時間` : `${h}時間${m}分`;
  const hoursShort = m === 0 ? `${h}h` : `${h}h${m}m`;
  if (el('count-work-hours')) el('count-work-hours').textContent = hoursLabel;

  const wage = parseFloat(el('wage-input')?.value ?? settings.wage) || 0;
  const totalWorkH = totalWorkMin / 60;
  const est = totalWorkH * wage;
  const estStr = `¥ ${Math.round(est).toLocaleString('ja-JP')}`;

  if (el('salary-est'))    el('salary-est').textContent    = estStr;
  if (el('salary-detail')) el('salary-detail').textContent = `${totalWorkH.toFixed(1)}h × ¥${wage.toLocaleString('ja-JP')}`;

  // ボトムバー更新（スマホ専用）
  if (el('salary-est-bar'))      el('salary-est-bar').textContent      = estStr;
  if (el('count-work-bar'))      el('count-work-bar').textContent      = `${counts.work}日`;
  if (el('count-work-hours-bar')) el('count-work-hours-bar').textContent = hoursShort;
}

// ===== 月切替 =====
function changeMonth(delta) {
  currentMonth += delta;
  if (currentMonth > 12) { currentMonth = 1;  currentYear++; }
  if (currentMonth < 1)  { currentMonth = 12; currentYear--; }
  renderMonthTitle();
  renderCalendar();
  updateSidebar();
}

// ===== トースト =====
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('opacity-0', 'pointer-events-none');
  toast.classList.add('opacity-100');
  setTimeout(() => {
    toast.classList.remove('opacity-100');
    toast.classList.add('opacity-0', 'pointer-events-none');
  }, 2200);
}

// ===== 月表示 =====
function renderMonthTitle() {
  const el = document.getElementById('month-title');
  if (el) el.textContent = `${currentYear}年 ${currentMonth}月`;
}

// ===== スタンプ選択ボタン同期 =====
function syncStampButtons() {
  Object.keys(STAMPS).forEach(key => {
    const btn = document.getElementById(`stamp-${key}`);
    if (!btn) return;
    if (key === activeStamp) {
      btn.classList.add('ring-2', 'ring-offset-1', 'ring-slate-400', 'scale-105');
      btn.classList.remove('opacity-60');
    } else {
      btn.classList.remove('ring-2', 'ring-offset-1', 'ring-slate-400', 'scale-105');
      btn.classList.add('opacity-60');
    }
  });
}

// ===== 設定パネル → settings に反映 =====
function syncSettingsFromUI() {
  const g = id => document.getElementById(id);
  settings.wage     = parseFloat(g('wage-input')?.value)     || settings.wage;
  settings.defStart = g('def-start')?.value                  || settings.defStart;
  settings.defEnd   = g('def-end')?.value                    || settings.defEnd;
  settings.defBreak = parseInt(g('def-break')?.value, 10)    ?? settings.defBreak;
  saveSettings();
  updateSidebar();
}

// ===== 設定パネルに初期値を反映 =====
function syncSettingsToUI() {
  const g = id => document.getElementById(id);
  if (g('wage-input'))  g('wage-input').value  = settings.wage;
  if (g('def-start'))   g('def-start').value   = settings.defStart;
  if (g('def-end'))     g('def-end').value      = settings.defEnd;
  if (g('def-break'))   g('def-break').value    = settings.defBreak;
}

// ===== 日別プレビューシート =====
let previewDay = null;

function openPreview(d) {
  previewDay = d;
  const key   = dateKey(currentYear, currentMonth, d);
  const entry = dayData[key];
  const dateStr = `${currentYear}年${currentMonth}月${d}日`;

  document.getElementById('preview-title').textContent = dateStr;

  const body = document.getElementById('preview-body');
  body.innerHTML = '';

  if (!entry) {
    // 未登録
    body.innerHTML = '<p class="text-slate-400 text-center py-2">まだ登録がありません</p>';
  } else {
    const stampDef = STAMPS[entry.stamp];
    const rows = [
      ['スタンプ', stampDef ? stampDef.label : '—'],
    ];
    if (entry.stamp === 'work') {
      rows.push(['開始', entry.start || '—']);
      rows.push(['終了', entry.end   || '—']);
      rows.push(['休憩', `${entry.breakMin ?? 0}分`]);
      const wMin = calcWorkMin(entry);
      if (wMin > 0) {
        const wage = parseFloat(document.getElementById('wage-input')?.value ?? settings.wage) || 0;
        const pay  = Math.round((wMin / 60) * wage);
        rows.push(['実働', `${minToLabel(wMin)}  ≈  ¥${pay.toLocaleString('ja-JP')}`]);
      }
    }
    if (entry.memo) rows.push(['メモ', entry.memo]);

    rows.forEach(([label, val]) => {
      const row = document.createElement('div');
      row.className = 'flex justify-between items-center border-b border-slate-100 py-1.5';
      row.innerHTML = `<span class="text-xs text-slate-400 font-medium">${label}</span><span class="text-sm font-semibold text-slate-700">${val}</span>`;
      body.appendChild(row);
    });
  }

  const preview = document.getElementById('day-preview');
  preview.classList.remove('hidden');
  preview.classList.add('flex');
  const scrollY = window.scrollY;
  document.body.style.top = `-${scrollY}px`;
  document.body.classList.add('modal-open');
  preview._openedAt = Date.now(); // 開いた時刻を記録
}

function closePreview() {
  const preview = document.getElementById('day-preview');
  preview.classList.add('hidden');
  preview.classList.remove('flex');
  const scrollY = Math.abs(parseInt(document.body.style.top || '0', 10));
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  window.scrollTo(0, scrollY);
  previewDay = null;
}

// ===== 日別編集モーダル =====
function openModal(d) {
  const key    = dateKey(currentYear, currentMonth, d);
  const entry  = dayData[key];
  const modal  = document.getElementById('day-modal');
  const dateStr = `${currentYear}年${currentMonth}月${d}日`;

  document.getElementById('modal-title').textContent = `${dateStr} の予定`;

  // スタンプ選択
  const stampSelect = document.getElementById('modal-stamp');
  stampSelect.value = entry?.stamp || activeStamp;

  // 時間入力（仕事以外でも設定可能にしておく）
  document.getElementById('modal-start').value    = entry?.start    ?? settings.defStart;
  document.getElementById('modal-end').value      = entry?.end      ?? settings.defEnd;
  document.getElementById('modal-break').value    = entry?.breakMin ?? settings.defBreak;
  document.getElementById('modal-memo').value     = entry?.memo     ?? '';

  syncModalStampButtons();
  updateModalCalc();
  toggleTimeSection();

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  // iOS Safari対応: スクロール位置を保持したまま body を固定
  const scrollY = window.scrollY;
  document.body.style.top = `-${scrollY}px`;
  document.body.classList.add('modal-open');
}

function closeModal() {
  const modal = document.getElementById('day-modal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  // スクロール位置を復元
  const scrollY = Math.abs(parseInt(document.body.style.top || '0', 10));
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  window.scrollTo(0, scrollY);
}

function toggleTimeSection() {
  const stamp  = document.getElementById('modal-stamp').value;
  const section = document.getElementById('modal-time-section');
  if (stamp === 'work') {
    section.classList.remove('hidden');
  } else {
    section.classList.add('hidden');
  }
}

function updateModalCalc() {
  const start    = document.getElementById('modal-start').value;
  const end      = document.getElementById('modal-end').value;
  const breakMin = parseInt(document.getElementById('modal-break').value, 10) || 0;
  const wage     = parseFloat(document.getElementById('wage-input')?.value ?? settings.wage) || 0;

  const s = timeToMin(start);
  const e = timeToMin(end);
  const workMin = (isNaN(s) || isNaN(e) || e <= s) ? 0 : Math.max(0, (e - s) - breakMin);
  const pay = (workMin / 60) * wage;

  const calcEl = document.getElementById('modal-calc');
  if (calcEl) {
    const h = Math.floor(workMin / 60);
    const m = workMin % 60;
    const timeStr = m === 0 ? `${h}時間` : `${h}時間${m}分`;
    calcEl.textContent = `実働 ${timeStr}  ≈  ¥${Math.round(pay).toLocaleString('ja-JP')}`;
  }
}

function saveModal() {
  const title   = document.getElementById('modal-title').textContent;
  // タイトルから日を逆引き
  const dayMatch = title.match(/(\d+)日/);
  if (!dayMatch) return;
  const d   = parseInt(dayMatch[1], 10);
  const key = dateKey(currentYear, currentMonth, d);

  const stamp    = document.getElementById('modal-stamp').value;
  const start    = document.getElementById('modal-start').value;
  const end      = document.getElementById('modal-end').value;
  const breakMin = parseInt(document.getElementById('modal-break').value, 10) || 0;
  const memo     = document.getElementById('modal-memo').value.trim();

  dayData[key] = { stamp, start, end, breakMin, memo };
  // memo のみ入力でスタンプなしの場合も保存を許可（stampは現activeStampを使用）
  if (!stamp) dayData[key].stamp = activeStamp;
  saveData();
  renderCalendar();
  updateSidebar();
  closeModal();
  showToast('保存しました');
}

function deleteModal() {
  const title    = document.getElementById('modal-title').textContent;
  const dayMatch = title.match(/(\d+)日/);
  if (!dayMatch) return;
  const d   = parseInt(dayMatch[1], 10);
  const key = dateKey(currentYear, currentMonth, d);
  delete dayData[key];
  saveData();
  renderCalendar();
  updateSidebar();
  closeModal();
  showToast('削除しました');
}

// ===== 初期化 =====
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  loadData();
  syncSettingsToUI();
  renderMonthTitle();
  renderCalendar();
  updateSidebar();
  syncStampButtons();

  document.getElementById('apply-btn').addEventListener('click', applyInput);
  document.getElementById('clear-btn').addEventListener('click', clearAll);
  document.getElementById('prev-month').addEventListener('click', () => changeMonth(-1));
  document.getElementById('next-month').addEventListener('click', () => changeMonth(+1));

  // スタンプ選択
  Object.keys(STAMPS).forEach(key => {
    const btn = document.getElementById(`stamp-${key}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      activeStamp = key;
      syncStampButtons();
      renderCalendar();
    });
  });

  // 設定入力 → リアルタイム反映
  ['wage-input', 'def-start', 'def-end', 'def-break'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', syncSettingsFromUI);
  });

  // Enterキーでも反映
  document.getElementById('day-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') applyInput();
  });

  // プレビューイベント
  document.getElementById('preview-close').addEventListener('click', closePreview);
  document.getElementById('preview-edit').addEventListener('click', () => {
    const d = previewDay;
    closePreview();
    openModal(d);
  });
  document.getElementById('preview-delete').addEventListener('click', () => {
    if (previewDay === null) return;
    const d = previewDay;
    closePreview();
    deleteDay(d);
  });
  document.getElementById('day-preview').addEventListener('click', e => {
    if (e.target !== e.currentTarget) return;
    const openedAt = e.currentTarget._openedAt || 0;
    if (Date.now() - openedAt < 350) return; // touchend直後のclickを無視
    closePreview();
  });

  // モーダルイベント
  document.getElementById('modal-save').addEventListener('click', saveModal);
  document.getElementById('modal-delete').addEventListener('click', deleteModal);
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-stamp').addEventListener('change', () => {
    syncModalStampButtons();
    toggleTimeSection();
    updateModalCalc();
  });
  ['modal-start', 'modal-end', 'modal-break'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateModalCalc);
  });
  // モーダル内のスタンプ横並びボタン
  document.querySelectorAll('.modal-stamp-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('modal-stamp').value = btn.dataset.value;
      syncModalStampButtons();
      toggleTimeSection();
      updateModalCalc();
    });
  });
  // モーダル背景クリックで閉じる
  document.getElementById('day-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  // アコーディオン
  document.querySelectorAll('.accordion-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      const icon   = btn.querySelector('.accordion-icon');
      const isOpen = target.classList.contains('open');
      target.classList.toggle('open', !isOpen);
      if (icon) icon.style.transform = isOpen ? '' : 'rotate(90deg)';
    });
  });
});

// ===== モーダル内スタンプボタン同期 =====
function syncModalStampButtons() {
  const val = document.getElementById('modal-stamp').value;
  document.querySelectorAll('.modal-stamp-btn').forEach(btn => {
    if (btn.dataset.value === val) {
      btn.classList.remove('opacity-60');
      btn.classList.add('ring-2', 'ring-offset-1', 'ring-slate-400', 'scale-105');
    } else {
      btn.classList.add('opacity-60');
      btn.classList.remove('ring-2', 'ring-offset-1', 'ring-slate-400', 'scale-105');
    }
  });
}
