// App.tsx
// 计数器演示组件，展示 hooks 状态管理和事件绑定
// 详见流程图 F->G->H->I->J->K
import { createElement, useState } from '../core';

function Counter() {
  // 使用 useState 管理 count 状态
  const [count, setCount] = useState(0);

  return createElement('div', {},
    createElement('h1', {}, `计数器：${count}`),
    // 点击按钮，调用 setCount 触发状态更新
    createElement('button', { onClick: () => setCount(count + 1) }, '递增')
  );
}

export function App() {
  // 并列展示两种架构计数器，方便体验对比
  return createElement('div', {},
    // createElement(NonFiberCounter, {}),
    createElement(Counter, {})
  );
}
