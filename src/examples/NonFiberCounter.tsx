// NonFiberCounter.tsx
// JSX 版：非 fiber 架构同步整块渲染对比示例
import { createElement, useState } from '../core';

const TOTAL = 20000; // 与 FiberCounter 保持一致

export function NonFiberCounter() {
  const [count, setCount] = useState(0);
  const t0 = performance.now();
  const items: any[] = [];
  for (let i = 0; i < TOTAL; i++) {
    items.push(<li key={i}>Item {i + count}</li>);
  }
  const buildMs = Math.round(performance.now() - t0);

  return (
    <div>
      <h2>非 fiber 架构（同步整块渲染）</h2>
      <div>
        <input
          placeholder="这里输入测试（可能卡顿）"
          style="width:260px;margin-right:8px;"
        />
        <button onClick={() => setCount((c:number)=>c+1)}>批量递增 ({count})</button>
      </div>
      <div style="margin:6px 0;font:12px/1.4 monospace;">
        同步一次性构建: {TOTAL} 条 | 耗时 ~ {buildMs} ms | 无中断/不可抢占
      </div>
      <ul>{items}</ul>
    </div>
  );
}
