import './styles.css';
import { ByteQueue } from './core/byte-queue';
import { getParser, PARSERS } from './core/parsers';
import { buildReadHolding, buildWriteRegister } from './core/parsers/modbus';
import { MockTransport, WebSerialTransport } from './core/transport';
import type { Transport } from './core/transport';
import { Stats } from './core/stats';
import { Recorder, hexToBytes, isRecording, replay } from './core/recorder';
import type { Recording } from './core/recorder';
import { MAX_RECORDING_FILE_BYTES } from './core/recorder';
import { WaveChart } from './ui/chart';
import { formatTime, parseHexInput, toHex, toText } from './core/bytes';
import type { DecodedFrame, Direction, Parser } from './core/types';

const MAX_ROWS = 1500;
const IDLE_FLUSH_MS = 120;
/** 帧头卡住时，空闲多久后强制重同步（内容由各协议自己判断） */
const IDLE_RESYNC_MS = 20;
const THEME_KEY = 'portscope-theme';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as unknown as T;
}

interface StreamRecord {
  ts: number;
  dir: Direction;
  bytes: Uint8Array;
  decoded: DecodedFrame;
}

const state = {
  transport: null as Transport | null,
  parser: PARSERS[0] as Parser,
  view: 'hex' as 'hex' | 'text' | 'decode',
  paused: false,
  lastDataAt: 0,
  hasHint: true,
  loopTimer: 0,
  replayCancel: null as (() => void) | null,
};

const queue = new ByteQueue(1 << 20);
const stats = new Stats();
const recorder = new Recorder();
const chart = new WaveChart(el<HTMLCanvasElement>('chart'));
const records: StreamRecord[] = [];
let rowEls: HTMLElement[] = [];
/** 已经上报给统计面板的丢弃字节数，用来算增量 */
let reportedDropped = 0;

/* ---------------------------------- 渲染 ---------------------------------- */

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}

function isBadFrame(decoded: DecodedFrame): boolean {
  return decoded.fields.some((f) => f.tone === 'err');
}

function createRow(record: StreamRecord): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';
  row.dataset.dir = record.dir;
  if (isBadFrame(record.decoded)) row.classList.add('is-bad');

  const ts = document.createElement('span');
  ts.className = 'row-ts';
  ts.textContent = formatTime(record.ts);

  const dir = document.createElement('span');
  dir.className = 'row-dir';
  dir.textContent = record.dir === 'rx' ? 'RX' : 'TX';

  const body = document.createElement('div');
  body.className = 'row-body';

  const main = document.createElement('span');
  main.className = 'row-main';

  if (state.view === 'text') {
    main.textContent = toText(record.bytes);
  } else if (state.view === 'decode') {
    main.textContent = record.decoded.title;
  } else {
    main.textContent = toHex(record.bytes);
  }
  body.appendChild(main);

  if (state.view === 'decode') {
    const meta = document.createElement('span');
    meta.className = 'row-meta';
    const tagClass = isBadFrame(record.decoded) ? 'tag tag-err' : 'tag tag-ok';
    const parts = record.decoded.fields
      .map((f) => `${f.k}=<b>${escapeHtml(f.v)}</b>`)
      .join(' · ');
    meta.innerHTML = `<span class="${tagClass}">${escapeHtml(record.decoded.protocol)}</span>${parts}`;
    body.appendChild(meta);
  }

  row.append(ts, dir, body);
  return row;
}

function pushRecord(record: StreamRecord): void {
  records.push(record);
  if (records.length > MAX_ROWS) records.shift();

  if (state.paused) return;

  const body = el<HTMLDivElement>('stream-body');
  if (state.hasHint) {
    body.querySelector('.empty-hint')?.remove();
    state.hasHint = false;
  }

  const row = createRow(record);
  body.appendChild(row);
  rowEls.push(row);
  if (rowEls.length > MAX_ROWS) {
    rowEls.shift()?.remove();
  }

  if (el<HTMLInputElement>('opt-autoscroll').checked) {
    body.scrollTop = body.scrollHeight;
  }
}

function rebuildStream(): void {
  const body = el<HTMLDivElement>('stream-body');
  body.textContent = '';
  state.hasHint = false;
  rowEls = records.map((r) => createRow(r));
  for (const row of rowEls) body.appendChild(row);
  body.scrollTop = body.scrollHeight;
}

function clearStream(): void {
  records.length = 0;
  rowEls = [];
  queue.clear();
  queue.resetDropped();
  reportedDropped = 0;
  const body = el<HTMLDivElement>('stream-body');
  body.textContent = '';
  const hint = document.createElement('div');
  hint.className = 'empty-hint';
  hint.innerHTML =
    '<p class="empty-title">还没有数据</p><p class="empty-sub">点击「模拟设备」立刻体验，无需任何硬件。</p>';
  body.appendChild(hint);
  state.hasHint = true;
}

/* ---------------------------------- 统计 ---------------------------------- */

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function renderStats(): void {
  const s = stats.snapshot();
  const cells: Array<[string, string, boolean]> = [
    ['RX 字节', formatBytes(s.rxBytes), false],
    ['TX 字节', formatBytes(s.txBytes), false],
    ['RX 帧', String(s.rxFrames), false],
    ['TX 帧', String(s.txFrames), false],
    ['接收速率', `${s.rxRate.toFixed(0)} B/s`, false],
    ['帧率', `${s.frameRate.toFixed(1)} /s`, false],
    ['CRC 错误', String(s.crcErrors), s.crcErrors > 0],
    ['异常响应', String(s.exceptions), s.exceptions > 0],
    ['丢弃字节', formatBytes(s.droppedBytes), s.droppedBytes > 0],
    ['待解析', `${queue.size} B`, false],
  ];
  el<HTMLDivElement>('stats-body').innerHTML = cells
    .map(
      ([k, v, bad]) =>
        `<div class="stat"><span class="stat-k">${k}</span><span class="stat-v${bad ? ' is-bad' : ''}">${v}</span></div>`,
    )
    .join('');

  const channels = chart.channelNames;
  el<HTMLSpanElement>('chart-hint').textContent =
    channels.length > 0 ? `${channels.length} 通道 · 独立缩放` : '等待解析器输出数值';
}

/* --------------------------------- 数据管线 -------------------------------- */

/** 用当前解析器解码一段完整字节（用于 TX 帧的即时展示）。 */
function decodeBytes(bytes: Uint8Array): DecodedFrame {
  const probe = new ByteQueue(8192);
  probe.push(bytes);
  const step = state.parser.parse(probe);
  if (step && step.kind === 'frame') return step.decoded;
  if (state.parser.flush) {
    const flushed = state.parser.flush(probe);
    if (flushed && flushed.kind === 'frame') return flushed.decoded;
  }
  return {
    protocol: 'Raw',
    title: `原始数据 ${bytes.length} 字节`,
    fields: [{ k: '长度', v: `${bytes.length} 字节` }],
    series: [],
  };
}

function handleStep(step: ReturnType<Parser['parse']>): boolean {
  if (!step) return false;
  if (step.kind === 'skip') {
    queue.discard(step.count);
    return true;
  }
  queue.discard(step.consumed);
  stats.addRxFrame();

  /*
   * 按帧级状态分类计数。CRC 错误和 Modbus 异常响应是两件完全不同的事：
   * 前者说明链路有问题（查线缆、波特率），后者说明设备明确回了错误码
   * （查寄存器地址、数量）。混在一个数字里，排查方向就丢了。
   */
  if (step.decoded.status === 'crc-error') {
    stats.addCrcError();
  } else if (step.decoded.status === 'exception') {
    stats.addException();
  }

  pushRecord({ ts: Date.now(), dir: 'rx', bytes: step.frame, decoded: step.decoded });
  if (step.decoded.series.length > 0) chart.push(step.decoded.series);
  return true;
}

function pump(): void {
  for (let guard = 0; guard < 512; guard++) {
    if (!handleStep(state.parser.parse(queue))) break;
  }
}

function onRxChunk(chunk: Uint8Array): void {
  state.lastDataAt = performance.now();
  stats.addRx(chunk.length);
  recorder.record('rx', chunk);
  queue.push(chunk);

  // 缓冲区溢出丢弃的字节要计入统计，否则界面看不出「数据其实缺了一截」
  const dropped = queue.droppedBytes;
  if (dropped > reportedDropped) {
    stats.addDropped(dropped - reportedDropped);
    reportedDropped = dropped;
  }

  pump();
}

/* --------------------------------- 发送侧 --------------------------------- */

async function sendBytes(bytes: Uint8Array): Promise<void> {
  if (!state.transport) {
    notice('请先连接串口，或点「模拟设备」在浏览器里跑一个从站。');
    return;
  }
  if (bytes.length === 0) return;
  try {
    await state.transport.write(bytes);
    stats.addTx(bytes.length);
    stats.addTxFrame();
    recorder.record('tx', bytes);
    pushRecord({ ts: Date.now(), dir: 'tx', bytes, decoded: decodeBytes(bytes) });
  } catch (err) {
    notice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function currentInput(): Uint8Array | null {
  const mode = el<HTMLSelectElement>('send-mode').value;
  const raw = el<HTMLInputElement>('send-input').value;
  if (mode === 'text') return new TextEncoder().encode(raw);
  return parseHexInput(raw);
}

async function sendFromInput(): Promise<void> {
  const bytes = currentInput();
  if (bytes === null) {
    notice('HEX 格式不正确，示例：01 03 00 00 00 04');
    return;
  }
  await sendBytes(bytes);
}

function setLoop(on: boolean): void {
  const btn = el<HTMLButtonElement>('btn-loop');
  if (state.loopTimer) {
    window.clearInterval(state.loopTimer);
    state.loopTimer = 0;
  }
  if (!on) {
    btn.classList.remove('is-on');
    btn.textContent = '循环发送';
    return;
  }
  const interval = Math.max(10, Number(el<HTMLInputElement>('send-interval').value) || 1000);
  btn.classList.add('is-on');
  btn.textContent = '停止循环';
  state.loopTimer = window.setInterval(() => {
    void sendFromInput();
  }, interval);
}

/* --------------------------------- 连接管理 -------------------------------- */

function currentBaud(): number {
  return Number(el<HTMLSelectElement>('cfg-baud').value) || 115200;
}

function updateConnectionUI(): void {
  const kind = state.transport?.kind ?? null;
  el<HTMLButtonElement>('btn-connect').textContent = kind === 'serial' ? '断开连接' : '连接串口';
  const mock = el<HTMLButtonElement>('btn-mock');
  mock.textContent = kind === 'mock' ? '停止模拟' : '模拟设备';
  mock.classList.toggle('is-on', kind === 'mock');
  el<HTMLButtonElement>('btn-loop').disabled = state.transport === null;
}

async function attach(transport: Transport): Promise<void> {
  await detach();
  transport.setHandlers({
    onData: onRxChunk,
    onClose: (reason) => {
      notice(reason ? `连接已断开：${reason}` : '连接已断开');
      void detach();
    },
  });
  await transport.open();
  state.transport = transport;
  queue.clear();
  updateConnectionUI();
}

async function detach(): Promise<void> {
  const current = state.transport;
  state.transport = null;
  setLoop(false);
  if (current) await current.close();
  updateConnectionUI();
}

async function connectSerial(): Promise<void> {
  if (state.transport?.kind === 'serial') {
    await detach();
    return;
  }
  const serial = navigator.serial;
  if (!serial) {
    notice('当前浏览器不支持 Web Serial。请用 Chrome / Edge 89+ 打开，且页面需为 HTTPS 或 localhost。');
    return;
  }
  try {
    const port = await serial.requestPort();
    const parity = el<HTMLSelectElement>('cfg-parity').value as 'none' | 'even' | 'odd';
    const transport = new WebSerialTransport(port, {
      baudRate: currentBaud(),
      dataBits: 8,
      stopBits: 1,
      parity,
      flowControl: 'none',
    });
    await attach(transport);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 用户点取消也会抛错，不必当成故障。
    if (!/No port selected|cancel/i.test(message)) notice(`打开串口失败：${message}`);
  }
}

async function toggleMock(): Promise<void> {
  if (state.transport?.kind === 'mock') {
    await detach();
    return;
  }
  const transport = new MockTransport(currentBaud);
  await attach(transport);

  el<HTMLInputElement>('send-input').value = toHex(buildReadHolding(1, 0, 4));
  el<HTMLSelectElement>('send-mode').value = 'hex';
  setLoop(true);
  notice('已启动模拟从站：4 个寄存器随正弦波变化。循环读取已自动开启。');
}

/* --------------------------------- 提示条 --------------------------------- */

let noticeTimer = 0;

function notice(message: string, ms = 5200): void {
  const banner = el<HTMLDivElement>('banner');
  banner.textContent = message;
  banner.hidden = false;
  window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => {
    banner.hidden = true;
  }, ms);
}

/* --------------------------------- 导出/录制 ------------------------------- */

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function exportCsv(): void {
  if (records.length === 0) {
    notice('还没有可导出的数据。');
    return;
  }
  const lines = ['时间,方向,长度,HEX'];
  for (const r of records) {
    lines.push(`${new Date(r.ts).toISOString()},${r.dir},${r.bytes.length},${toHex(r.bytes)}`);
  }
  download(`portscope-${stamp()}.csv`, lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function toggleRecord(): void {
  const btn = el<HTMLButtonElement>('btn-record');
  if (recorder.isActive) {
    const recording = recorder.stop();
    btn.classList.remove('is-rec');
    btn.textContent = '开始录制';
    if (recording) {
      download(
        `portscope-${stamp()}.json`,
        JSON.stringify(recording, null, 2),
        'application/json',
      );
      notice(
        recorder.isTruncated
          ? `录制结束：已达 ${recording.events.length} 条上限，之后的数据未记录。`
          : `录制结束：${recording.events.length} 条事件已保存为 JSON。`,
      );
    } else {
      notice('录制期间没有捕获到数据。');
    }
    return;
  }
  recorder.start(state.parser.id, currentBaud());
  btn.classList.add('is-rec');
  btn.textContent = '停止录制';
  notice('开始录制，再次点击即可保存为 JSON。', 3000);
}

function stopReplay(): void {
  state.replayCancel?.();
  state.replayCancel = null;
  const btn = el<HTMLButtonElement>('btn-replay');
  btn.textContent = '回放';
  btn.disabled = false;
}

function startReplay(recording: Recording): void {
  stopReplay();
  clearStream();
  stats.reset();
  chart.clear();

  const btn = el<HTMLButtonElement>('btn-replay');
  btn.textContent = '停止回放';
  btn.disabled = false;

  state.replayCancel = replay(
    recording,
    (event) => {
      const bytes = hexToBytes(event.hex);
      if (event.dir === 'rx') {
        onRxChunk(bytes);
      } else {
        stats.addTx(bytes.length);
        stats.addTxFrame();
        pushRecord({ ts: Date.now(), dir: 'tx', bytes, decoded: decodeBytes(bytes) });
      }
    },
    () => {
      state.replayCancel = null;
      stopReplay();
      notice('回放结束。');
    },
  );
  notice(`正在回放 ${recording.events.length} 条事件（${new Date(recording.createdAt).toLocaleString()}）`, 3000);
}

function pickRecording(): void {
  if (state.replayCancel) {
    stopReplay();
    return;
  }
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;

    if (file.size > MAX_RECORDING_FILE_BYTES) {
      notice(`录制文件 ${(file.size / 1024 / 1024).toFixed(1)} MB，超过 32 MB 上限，已拒绝。`);
      return;
    }

    void file.text().then((text) => {
      try {
        const data: unknown = JSON.parse(text);
        if (!isRecording(data)) {
          notice('这不是有效的 PortScope 录制文件（格式、版本或事件内容校验未通过）。');
          return;
        }
        startReplay(data);
      } catch {
        notice('JSON 解析失败，文件可能已损坏。');
      }
    });
  });
  input.click();
}

/* --------------------------------- 快捷指令 -------------------------------- */

interface QuickCommand {
  label: string;
  bytes: Uint8Array;
}

function buildQuickCommands(): QuickCommand[] {
  return [
    { label: '读 R0..R3', bytes: buildReadHolding(1, 0, 4) },
    { label: '读 R0', bytes: buildReadHolding(1, 0, 1) },
    { label: '写 R0=500', bytes: buildWriteRegister(1, 0, 500) },
    { label: '非法地址', bytes: buildReadHolding(1, 16, 2) },
  ];
}

function renderQuickCommands(): void {
  const bar = el<HTMLDivElement>('quick-bar');
  bar.textContent = '';
  for (const cmd of buildQuickCommands()) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = `${cmd.label} · ${toHex(cmd.bytes)}`;
    chip.addEventListener('click', () => {
      el<HTMLInputElement>('send-input').value = toHex(cmd.bytes);
      el<HTMLSelectElement>('send-mode').value = 'hex';
      void sendBytes(cmd.bytes);
    });
    bar.appendChild(chip);
  }
}

/* --------------------------------- 初始化 --------------------------------- */

function initTheme(): void {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') {
    document.documentElement.dataset.theme = saved;
  }
}

function bindEvents(): void {
  el<HTMLButtonElement>('btn-connect').addEventListener('click', () => void connectSerial());
  el<HTMLButtonElement>('btn-mock').addEventListener('click', () => void toggleMock());
  el<HTMLButtonElement>('btn-send').addEventListener('click', () => void sendFromInput());
  el<HTMLButtonElement>('btn-loop').addEventListener('click', () => {
    setLoop(!state.loopTimer);
  });
  el<HTMLButtonElement>('btn-clear').addEventListener('click', () => clearStream());
  el<HTMLButtonElement>('btn-export').addEventListener('click', () => exportCsv());
  el<HTMLButtonElement>('btn-record').addEventListener('click', () => toggleRecord());
  el<HTMLButtonElement>('btn-replay').addEventListener('click', () => pickRecording());
  el<HTMLButtonElement>('btn-theme').addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'light' ? 'dark' : 'light';
    root.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  });

  el<HTMLInputElement>('send-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendFromInput();
    }
  });

  el<HTMLInputElement>('opt-pause').addEventListener('change', (event) => {
    state.paused = (event.target as HTMLInputElement).checked;
    if (!state.paused && records.length > 0) rebuildStream();
  });

  for (const btn of document.querySelectorAll<HTMLButtonElement>('.seg-btn')) {
    btn.addEventListener('click', () => {
      state.view = (btn.dataset.view as 'hex' | 'text' | 'decode') ?? 'hex';
      for (const other of document.querySelectorAll('.seg-btn')) other.classList.remove('is-active');
      btn.classList.add('is-active');
      rebuildStream();
    });
  }

  el<HTMLSelectElement>('cfg-parser').addEventListener('change', (event) => {
    state.parser = getParser((event.target as HTMLSelectElement).value);
    queue.clear();
    chart.clear();
    notice(`${state.parser.name}：${state.parser.hint}`, 3200);
  });
}

function init(): void {
  initTheme();

  const select = el<HTMLSelectElement>('cfg-parser');
  for (const parser of PARSERS) {
    const option = document.createElement('option');
    option.value = parser.id;
    option.textContent = parser.name;
    select.appendChild(option);
  }
  select.value = state.parser.id;

  renderQuickCommands();
  bindEvents();
  updateConnectionUI();

  if (!navigator.serial) {
    notice('当前浏览器不支持 Web Serial（Chrome / Edge 89+ 才支持）。仍可点击「模拟设备」体验全部功能。', 12000);
  }

  // 定时渲染统计，避免每来一帧就重排 DOM。
  window.setInterval(renderStats, 250);
  renderStats();

  /*
   * 空闲处理，两件事：
   * 1. 原始流这类无法自定界的协议，靠空闲间隔切帧（flush）
   * 2. Modbus 遇到噪声凑出的超长候选帧会一直等下去，空闲超时后
   *    必须丢弃队首字节重同步，否则后面的有效帧全被堵住（onIdle）
   */
  window.setInterval(() => {
    if (queue.size === 0) return;

    const idle = performance.now() - state.lastDataAt;

    const flush = state.parser.flush;
    if (flush && idle >= IDLE_FLUSH_MS) {
      const step = flush.call(state.parser, queue);
      if (step) {
        handleStep(step);
        pump();
      }
      return;
    }

    const onIdle = state.parser.onIdle;
    if (onIdle && idle >= IDLE_RESYNC_MS) {
      const step = onIdle.call(state.parser, queue, idle);
      if (step) {
        handleStep(step);
        pump();
      }
    }
  }, 60);
  // 分享演示链接用：?demo=1 自动启动模拟从站
  if (new URLSearchParams(location.search).has('demo')) {
    void toggleMock();
  }
}

init();
