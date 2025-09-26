// App.tsx
// 基于自定义 createElement 的 JSX 示例入口组件
import { createElement, useState } from '../core';
import { FiberCounter } from './FiberCounter';
// import { NonFiberCounter } from './NonFiberCounter';

export function App() {
  const [demo, setDemo] = useState(0);
  return (
    <div>
      <h1 style={{ fontFamily: 'monospace' }}>React-mini 示例 (demo={demo})</h1>
      <button onClick={() => setDemo((d: number) => d + 1)}>本地计数 +1</button>
      <FiberCounter />
    </div>
  );
}
