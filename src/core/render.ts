// render.ts
// 渲染入口：现已默认走 Fiber 架构 Phase1（双缓冲 + 同步 workLoop + 提交阶段）
// 如需回退旧实现，可调用 legacyRender。
import type { VNode } from './types';
import { diff } from './diff';
import { renderRoot } from './fiber';

// 新：Fiber 渲染
export function render(vnode: VNode, container: HTMLElement) {
  renderRoot(vnode, container);
}

// 旧：同步 diff 渲染回退（保留调试）
export function legacyRender(vnode: VNode, container: HTMLElement) {
  const prevVNode = (container as any)._vnode;
  const nextVNode = vnode;
  diff(prevVNode, nextVNode, container);
  (container as any)._vnode = nextVNode;
}
