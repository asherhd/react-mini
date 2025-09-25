// NonFiberCounter.tsx
// 非 fiber 架构计数器（改造版）：同步一次性构建大量节点，对比 FiberCounter 的可中断分片效果
// 特点：
// 1. 每次点击都会同步构建 TOTAL 条 <li>（主线程长任务）
// 2. 无中断、无增量提交，可能导致输入/多次点击卡顿
// 3. 展示一次构建耗时，方便与 fiber 版本对比
import { createElement, useState } from '../core';

const TOTAL = 20000; // 与 FiberCounter 保持一致

export function NonFiberCounter() {
  const [count, setCount] = useState(0);
  // 同步构建开始计时
  const t0 = performance.now();
  const items: any[] = [];
  for (let i = 0; i < TOTAL; i++) {
    items.push(createElement('li', {}, `Item ${i + count}`));
  }
  const buildMs = Math.round(performance.now() - t0);

  return createElement('div', {},
    createElement('h2', {}, '非 fiber 架构（同步整块渲染）'),
    createElement('div', {},
      createElement('input', {
        placeholder: '这里输入测试（可能卡顿）',
        style: 'width:260px;margin-right:8px;'
      }),
      createElement('button', { onClick: () => setCount((c: number) => c + 1) }, `批量递增 (${count})`)
    ),
    createElement('div', { style: 'margin:6px 0;font:12px/1.4 monospace;' },
      `同步一次性构建: ${TOTAL} 条 | 耗时 ~ ${buildMs} ms | 无中断/不可抢占`
    ),
    createElement('ul', {}, ...items)
  );
}
