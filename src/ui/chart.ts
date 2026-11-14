import type { SeriesPoint } from '../core/types';

interface ChannelPoint {
  t: number;
  v: number;
}

interface Channel {
  label: string;
  color: string;
  points: ChannelPoint[];
}

const COLORS = ['#4dd4ac', '#4d9dff', '#f0a35e', '#d878c8', '#e3c04a', '#7ad4e0'];
const MAX_CHANNELS = 6;

/**
 * 手写 Canvas 波形图而不是引 Chart.js：
 * 串口数据是高频流式的，需要「推一个点就画」的低开销路径，
 * 通用图表库的抽象层反而成了负担。整个绘制逻辑不到 150 行。
 */
export class WaveChart {
  private readonly ctx: CanvasRenderingContext2D;
  private channels: Channel[] = [];
  private width = 0;
  private height = 0;
  private dpr = 1;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法获取 2D 绘图上下文');
    this.ctx = ctx;

    const observer = new ResizeObserver(() => this.resize());
    observer.observe(canvas);
    this.resize();
    this.loop();
  }

  get channelNames(): string[] {
    return this.channels.map((c) => c.label);
  }

  push(points: SeriesPoint[], now = performance.now()): void {
    for (const point of points) {
      let channel = this.channels.find((c) => c.label === point.label);
      if (!channel) {
        if (this.channels.length >= MAX_CHANNELS) continue;
        channel = {
          label: point.label,
          color: COLORS[this.channels.length % COLORS.length],
          points: [],
        };
        this.channels.push(channel);
      }
      channel.points.push({ t: now, v: point.value });
      // 只保留窗口外的少量余量，避免数组无限增长。
      const cutoff = now - 35_000;
      let drop = 0;
      while (drop < channel.points.length && channel.points[drop].t < cutoff) drop++;
      if (drop > 0) channel.points.splice(0, drop);
    }
  }

  clear(): void {
    this.channels = [];
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(120, rect.width);
    this.height = Math.max(80, rect.height);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private loop = (): void => {
    this.draw();
    requestAnimationFrame(this.loop);
  };

  private draw(): void {
    const { ctx, width: w, height: h } = this;
    const styles = getComputedStyle(document.documentElement);
    const bg = styles.getPropertyValue('--bg-elev').trim() || '#151a21';
    const grid = styles.getPropertyValue('--border').trim() || '#232a33';
    const dim = styles.getPropertyValue('--text-faint').trim() || '#5b6676';

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const padL = 10;
    const padR = 10;
    const padT = 22;
    const padB = 16;
    const plotW = Math.max(10, w - padL - padR);
    const plotH = Math.max(10, h - padT - padB);

    if (this.channels.length === 0) {
      ctx.fillStyle = dim;
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('暂无数据', w / 2, h / 2);
      return;
    }

    const now = performance.now();

    // 时间窗口自适应：数据不足 30 秒时按实际跨度铺满，避免曲线挤在右边缘
    let earliest = Infinity;
    for (const ch of this.channels) {
      const first = ch.points[0];
      if (first && first.t < earliest) earliest = first.t;
    }
    const dataSpan = Number.isFinite(earliest) ? now - earliest : 0;
    const span = Math.min(30_000, Math.max(6_000, dataSpan + 800));
    const from = now - span;

    const xOf = (t: number): number => padL + ((t - from) / span) * plotW;

    // 水平网格
    ctx.strokeStyle = grid;
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 4; i++) {
      const y = padT + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    }

    // 时间刻度
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = dim;
    ctx.textBaseline = 'top';
    for (let i = 0; i <= 3; i++) {
      const x = padL + (plotW / 3) * i;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      const seconds = (span / 1000) * (1 - i / 3);
      ctx.textAlign = i === 0 ? 'left' : i === 3 ? 'right' : 'center';
      ctx.fillText(i === 3 ? '0s' : `-${Math.round(seconds)}s`, x, padT + plotH + 4);
    }

    // 各通道：独立纵向缩放，否则量级差异大的寄存器会被压成一条直线
    for (const ch of this.channels) {
      const visible = ch.points.filter((p) => p.t >= from);
      if (visible.length < 2) continue;

      let cmin = Infinity;
      let cmax = -Infinity;
      for (const p of visible) {
        if (p.v < cmin) cmin = p.v;
        if (p.v > cmax) cmax = p.v;
      }
      if (cmax - cmin < 1e-6) {
        cmin -= 1;
        cmax += 1;
      }
      const margin = (cmax - cmin) * 0.12;
      const base = cmin - margin;
      const range = cmax - cmin + margin * 2;
      const yOf = (v: number): number => padT + (1 - (v - base) / range) * plotH;

      ctx.beginPath();
      ctx.strokeStyle = ch.color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      for (let i = 0; i < visible.length; i++) {
        const x = xOf(visible[i].t);
        const y = yOf(visible[i].v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      const last = visible[visible.length - 1];
      ctx.beginPath();
      ctx.arc(xOf(last.t), yOf(last.v), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = ch.color;
      ctx.fill();
    }

    // 图例：通道名 + 当前原始值
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '10px ui-monospace, monospace';
    let lx = padL;
    for (const ch of this.channels) {
      const last = ch.points[ch.points.length - 1];
      const text = last ? `${ch.label} ${formatTick(last.v)}` : ch.label;
      ctx.fillStyle = ch.color;
      ctx.fillRect(lx, 10, 6, 2);
      ctx.fillStyle = dim;
      ctx.fillText(text, lx + 10, 11);
      lx += ctx.measureText(text).width + 22;
      if (lx > w - 40) break;
    }
  }
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 10000) return (value / 1000).toFixed(1) + 'k';
  if (abs >= 100) return value.toFixed(0);
  if (abs >= 1) return value.toFixed(1);
  return value.toFixed(2);
}
