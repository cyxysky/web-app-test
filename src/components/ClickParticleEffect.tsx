'use client';

import { useEffect, useRef } from 'react';

type ClickParticle = {
  age: number;
  color: readonly [number, number, number];
  life: number;
  px: number;
  py: number;
  size: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
};

const CLICK_PARTICLE_COLORS = [
  [104, 244, 255],
  [101, 143, 255],
  [208, 107, 255],
  [255, 255, 255],
] as const;
const CLICK_PARTICLE_LIMIT = 31;
const CLICK_BURST_MIN_INTERVAL_MS = 200;

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

export function ClickParticleEffect() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    const drawingContext: CanvasRenderingContext2D = context;

    const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let particles: ClickParticle[] = [];
    let animationFrame = 0;
    let lastBurstAt = 0;
    let lastFrameAt = performance.now();
    let width = window.innerWidth;
    let height = window.innerHeight;

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * pixelRatio));
      canvas.height = Math.max(1, Math.round(height * pixelRatio));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      drawingContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      drawingContext.clearRect(0, 0, width, height);
    };

    const scheduleFrame = () => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(drawFrame);
    };

    const createBurst = (x: number, y: number) => {
      const now = performance.now();
      if (now - lastBurstAt < CLICK_BURST_MIN_INTERVAL_MS) return;
      lastBurstAt = now;
      const amount = reducedMotionQuery.matches ? 4 : 10;
      const nextParticles = Array.from({ length: amount }, (_, index): ClickParticle => {
        const angle = Math.random() * Math.PI * 2;
        const speed = randomBetween(0.8, 4.2);
        return {
          age: 0,
          color: CLICK_PARTICLE_COLORS[index % CLICK_PARTICLE_COLORS.length],
          life: randomBetween(22, 54),
          px: x,
          py: y,
          size: randomBetween(0.35, 1.15),
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          x,
          y,
        };
      });
      particles = [...particles, ...nextParticles].slice(-CLICK_PARTICLE_LIMIT);
      lastFrameAt = now;
      scheduleFrame();
    };

    function drawFrame(now: number) {
      animationFrame = 0;
      const delta = Math.min(2.2, (now - lastFrameAt) / 16.667 || 1);
      lastFrameAt = now;
      drawingContext.clearRect(0, 0, width, height);
      drawingContext.globalCompositeOperation = 'lighter';
      drawingContext.lineCap = 'round';

      const activeParticles: ClickParticle[] = [];
      for (const particle of particles) {
        particle.px = particle.x;
        particle.py = particle.y;
        particle.vx *= Math.pow(0.965, delta);
        particle.vy *= Math.pow(0.965, delta);
        particle.x += particle.vx * delta;
        particle.y += particle.vy * delta;
        particle.age += delta;
        if (particle.age >= particle.life) continue;

        const alpha = Math.max(0, 1 - particle.age / particle.life);
        const [red, green, blue] = particle.color;
        const gradient = drawingContext.createLinearGradient(particle.px, particle.py, particle.x, particle.y);
        gradient.addColorStop(0, `rgba(${red}, ${green}, ${blue}, ${alpha * 0.18})`);
        gradient.addColorStop(1, `rgba(${red}, ${green}, ${blue}, ${alpha})`);
        drawingContext.strokeStyle = gradient;
        drawingContext.lineWidth = particle.size;
        drawingContext.shadowBlur = 4;
        drawingContext.shadowColor = `rgba(${red}, ${green}, ${blue}, ${alpha * 0.72})`;
        drawingContext.beginPath();
        drawingContext.moveTo(particle.px, particle.py);
        drawingContext.lineTo(particle.x, particle.y);
        drawingContext.stroke();
        activeParticles.push(particle);
      }

      drawingContext.shadowBlur = 0;
      drawingContext.globalCompositeOperation = 'source-over';
      particles = activeParticles;
      if (particles.length) scheduleFrame();
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0) return;
      const target = event.target;
      if (target instanceof Element && target.closest('[data-disable-click-particles]')) return;
      createBurst(event.clientX, event.clientY);
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        lastFrameAt = performance.now();
        if (particles.length) scheduleFrame();
        return;
      }
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    resize();
    window.addEventListener('pointerdown', handlePointerDown, { capture: true, passive: true });
    window.addEventListener('resize', resize, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  return <canvas aria-hidden="true" className="ui-click-particle-canvas" ref={canvasRef} />;
}
