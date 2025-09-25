// FiberCounter.tsx
// 简化版：固定行高 + 虚拟化窗口 + offset 计数 (O(1) 更新文本)
// 去除：不均匀行高测量 / 分片首构建 / 进度条 / FPS 统计
// 目标：清晰示例 - 固定高度容器内，内容根据滚动虚拟化填充，超出自动滚动
import { createElement, useState, useEffect } from '../core';

const TOTAL = 20000;          // 总行数
const ROW_HEIGHT = 20;         // 固定行高 (px)
const VIEWPORT_HEIGHT = 400;   // 容器高度
const OVERSCAN = 6;            // 上下预加载行数

function calcRange(scrollTop: number, vpHeight: number) {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(vpHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(TOTAL, start + visible);
  return { start, end };
}

export function FiberCounter() {
  const [count, setCount] = useState(0);        // 低优先级计数（offset）
  const [highCount, setHighCount] = useState(0);// 高优先级演示（不影响大列表）
  const [scrollTop, setScrollTop] = useState(0);
  const [viewPort, setViewPort] = useState({ start:0, end:0, height:VIEWPORT_HEIGHT });
  const [items, setItems] = useState([] as any[]);

  // 注入基础样式（只一次）
  useEffect(() => {
    if (!document.getElementById('fiber-simple-css')) {
      const style = document.createElement('style');
      style.id = 'fiber-simple-css';
      style.textContent = `
        .fiber-viewport { position:relative; overflow:auto; border:1px solid #ccc; height:${VIEWPORT_HEIGHT}px; background:#fff; font:12px/1 monospace; }
        .fiber-offset-list { list-style:none; margin:0; padding:0; counter-reset:item 0; }
        .fiber-offset-list > li { counter-increment:item; height:${ROW_HEIGHT}px; line-height:${ROW_HEIGHT}px; box-sizing:border-box; padding:0 4px; }
        .fiber-offset-list > li::before { content:'Item ' counter(item); display:inline-block; margin-right:4px; color:#555; }
      `;
      document.head.appendChild(style);
    }
  }, []);

  // 初始化首个窗口
  useEffect(() => {
    if (items.length === 0) buildWindow(0);
  }, []);

  // 滚动时更新窗口
  useEffect(() => {
    const { start, end } = calcRange(scrollTop, viewPort.height);
    if (start !== viewPort.start || end !== viewPort.end) buildWindow(scrollTop);
  }, [scrollTop, viewPort.start, viewPort.end, viewPort.height]);

  function buildWindow(st: number) {
    const { start, end } = calcRange(st, viewPort.height);
    const slice: any[] = [];
    for (let i = start; i < end; i++) {
      // 内容留空，统一用 CSS counter 展示序号；offset 技术让 count 变化 O(1) 更新
      slice.push(createElement('li', { key: i }, ''));
    }
    setItems(slice);
    setViewPort((v:any) => ({ ...v, start, end }));
  }

  function onScroll(e: any) { setScrollTop((e.target as HTMLElement).scrollTop); }

  // 固定高度整体估算
  const totalHeight = TOTAL * ROW_HEIGHT;
  const topOffset = viewPort.start * ROW_HEIGHT;

  // 高优先级区域（演示不受大列表影响）
  function liveArea() {
    const n = (highCount % 5) + 1; const arr:any[]=[];
    for (let i=0;i<n;i++) arr.push(createElement('li',{key:'live-'+i},`⚡ Live ${i+1} | high=${highCount}`));
    return arr;
  }

  return createElement('div', { style:'padding:8px;border:1px solid #bbb;margin-bottom:12px;font-family:monospace;' },
    createElement('h2', {}, 'fiber 架构（固定行高虚拟化 + offset）'),
    createElement('div', {},
      createElement('input', { placeholder:'高优先级输入（应流畅）', style:'width:240px;margin-right:8px;' }),
      createElement('button', { onClick: () => setCount((c:any)=>c+1,'normal') }, `低优先级 +1 (count=${count})`),
      createElement('button', { onClick: () => setHighCount((c:any)=>c+1, 'high'), style:'margin-left:8px;' }, `高优先级 +1 (high=${highCount})`),
      createElement('button', { onClick: () => setCount((c:any)=>c+5,'low'), style:'margin-left:8px;' }, '低优先级 +5(low)'),
      createElement('button', { onClick: () => setCount((c:any)=>c+1,'idle'), style:'margin-left:8px;' }, 'idle +1'),
      createElement('button', { onClick: () => setHighCount((c:any)=>c+1,'user-blocking'), style:'margin-left:8px;color:#c00;' }, '极高优先(user-blocking)')
    ),
    createElement('div', { style:'margin:6px 0;font:12px/1.4 monospace;color:#333;' },
      `窗口: [${viewPort.start}, ${viewPort.end}) / ${TOTAL} | 行高:${ROW_HEIGHT}px | 容器:${viewPort.height}px | 滚动:${scrollTop}px`),
    createElement('div', { className:'fiber-viewport', onScroll },
      createElement('div', { style:`height:${totalHeight}px;position:relative;` },
        createElement('div', { style:`position:absolute;top:${topOffset}px;left:0;right:0;` },
          createElement('ol', { className:'fiber-offset-list', style:`counter-reset:item ${count + viewPort.start};` }, ...items)
        )
      )
    ),
    createElement('div', { style:'margin:8px 0;padding:6px;border:1px dashed #aaa;background:#f9f9f9;' },
      createElement('strong', {}, '高优先级区'),
      createElement('ul', { style:'margin:4px 0;' }, ...liveArea())
    )
  );
}
