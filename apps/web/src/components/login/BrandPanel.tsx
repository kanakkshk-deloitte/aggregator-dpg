'use client';

import Image from 'next/image';
import { useRef, useEffect, type JSX } from 'react';
import { useAggregatorConfig, DEFAULT_AGGREGATOR_CONFIG } from '../../hooks/useAggregatorConfig';
import { mix, parseHex } from '../../lib/hex-color';
import { randomUnit } from '../../lib/random';

interface Dot {
  ax: number;
  ay: number;
  x: number;
  y: number;
  dPhaseX: number;
  dPhaseY: number;
  dSpeedX: number;
  dSpeedY: number;
  dAmpX: number;
  dAmpY: number;
  r: number;
  pulse: number;
  hue: 'bright' | 'soft';
}

/**
 * Animated brand panel rendering the Blue Dots particle network on a canvas.
 * Used by the public login and register pages as the left-side hero.
 *
 * @returns Brand panel React element with hero copy and stats.
 */
export function BrandPanel(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { data: cfg = DEFAULT_AGGREGATOR_CONFIG } = useAggregatorConfig();
  // Brand palette sets the hero gradient and particle colours.
  const primary = cfg.brand.primary_color ?? '#2563EB';
  const accent = cfg.brand.accent_color ?? primary;
  // Hero gradient: primary mixed toward black, light enough that warm brand
  // colours do not turn brown.
  const heroGradient = `linear-gradient(135deg, ${mix(primary, '#000000', 0.4)} 0%, ${mix(primary, '#000000', 0.2)} 45%, ${primary} 100%)`;
  const radialOverlay =
    `radial-gradient(700px 500px at 75% 25%, ${hexToRgba(accent, 0.18)} 0%, ${hexToRgba(accent, 0)} 60%),` +
    `radial-gradient(600px 480px at 15% 85%, ${hexToRgba(primary, 0.2)} 0%, ${hexToRgba(primary, 0)} 60%)`;
  const dotColors = {
    bright: mix(accent, '#FFFFFF', 0.4),
    soft: mix(primary, '#FFFFFF', 0.5),
  };
  const linkRgba = hexToRgba(mix(accent, '#FFFFFF', 0.6), 0.55);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx: CanvasRenderingContext2D | null = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = (): void => {
      const r = canvas.getBoundingClientRect();
      canvas.width = r.width * dpr;
      canvas.height = r.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    let dots: Dot[] = [];

    const buildDots = (): void => {
      const W = canvas.getBoundingClientRect().width;
      const H = canvas.getBoundingClientRect().height;
      if (W < 10 || H < 10) return;
      const COUNT = Math.max(55, Math.min(85, Math.round((W * H) / 18000)));
      const aspect = W / H;
      const COLS = Math.max(6, Math.round(Math.sqrt(COUNT * aspect)));
      const ROWS = Math.ceil(COUNT / COLS);
      const cellW = W / COLS;
      const cellH = H / ROWS;
      const next: Dot[] = [];
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          if (next.length >= COUNT) break;
          const cx = cellW * (c + 0.2 + randomUnit() * 0.6);
          const cy = cellH * (r + 0.2 + randomUnit() * 0.6);
          next.push({
            ax: cx,
            ay: cy,
            x: cx,
            y: cy,
            dPhaseX: randomUnit() * Math.PI * 2,
            dPhaseY: randomUnit() * Math.PI * 2,
            dSpeedX: 0.003 + randomUnit() * 0.004,
            dSpeedY: 0.003 + randomUnit() * 0.004,
            dAmpX: 6 + randomUnit() * 10,
            dAmpY: 6 + randomUnit() * 10,
            r: randomUnit() * 1.6 + 1.6,
            pulse: randomUnit() * Math.PI * 2,
            hue: randomUnit() < 0.22 ? 'bright' : 'soft',
          });
        }
      }
      dots = next;
    };

    const onResize = (): void => {
      resize();
      buildDots();
    };
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(canvas);

    const W = (): number => canvas.getBoundingClientRect().width;
    const H = (): number => canvas.getBoundingClientRect().height;

    const draw = (): void => {
      const w = W();
      const h = H();
      ctx.clearRect(0, 0, w, h);

      const LINK = 200;
      for (let i = 0; i < dots.length; i++) {
        for (let j = i + 1; j < dots.length; j++) {
          const a = dots[i];
          const b = dots[j];
          if (!a || !b) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < LINK) {
            const o = 1 - d / LINK;
            ctx.strokeStyle = applyAlpha(linkRgba, o);
            ctx.lineWidth = 0.9;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      dots.forEach((d) => {
        d.dPhaseX += d.dSpeedX;
        d.dPhaseY += d.dSpeedY;
        d.x = d.ax + Math.sin(d.dPhaseX) * d.dAmpX;
        d.y = d.ay + Math.cos(d.dPhaseY) * d.dAmpY;

        d.pulse += 0.02;
        const pulse = (Math.sin(d.pulse) + 1) / 2;
        const r = d.r + pulse * 0.6;

        const isBright = d.hue === 'bright';
        const core = isBright ? dotColors.bright : dotColors.soft;
        const glow = isBright ? hexToRgbaPrefix(dotColors.bright) : hexToRgbaPrefix(dotColors.soft);

        const grad = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, r * 6);
        grad.addColorStop(0, glow + (0.5 + pulse * 0.3) + ')');
        grad.addColorStop(1, glow + '0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r * 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(d.x, d.y, r, 0, Math.PI * 2);
        ctx.fill();
      });

      raf = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [primary, accent, linkRgba, dotColors.bright, dotColors.soft]);

  return (
    <div
      className="hidden lg:flex relative w-[52%] flex-col justify-between p-12 overflow-hidden text-white"
      style={{ background: heroGradient }}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />

      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{ background: radialOverlay }}
      />

      <div className="relative z-10 flex flex-col items-start justify-center flex-1 max-w-[640px]">
        {cfg.brand.logo?.withStraplineLight ? (
          <Image
            src={cfg.brand.logo.withStraplineLight}
            alt={cfg.brand.short_name}
            width={520}
            height={180}
            priority
            className="w-auto h-[140px] xl:h-[160px] object-contain object-left"
          />
        ) : (
          <h1 className="font-display font-bold tracking-tight leading-[1.05] text-[48px] xl:text-[56px] text-white">
            {cfg.brand.short_name}
          </h1>
        )}
      </div>

      <div className="relative z-10" />
    </div>
  );
}

/**
 * `#rrggbb` to `rgba(r,g,b,alpha)`. Returns the input unchanged when it does
 * not parse.
 */
function hexToRgba(hex: string, alpha: number): string {
  const c = parseHex(hex);
  if (!c) return hex;
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}

/** `#rrggbb` to `rgba(r,g,b,` (the caller appends the alpha and `)`). */
function hexToRgbaPrefix(hex: string): string {
  const c = parseHex(hex);
  if (!c) return 'rgba(255,255,255,';
  return `rgba(${c[0]},${c[1]},${c[2]},`;
}

/**
 * Multiplies the trailing alpha of an `rgba(...)` string by `opacity`, so
 * link lines fade from the brand's base alpha.
 */
function applyAlpha(rgba: string, opacity: number): string {
  return rgba.replace(/,\s*([0-9.]+)\)\s*$/, (_, a) => `,${Number(a) * opacity})`);
}
