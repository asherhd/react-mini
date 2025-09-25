// reconciler.ts
// 递归调和 VNode 树，调用 diff
// reconciler.ts
// 递归调和 VNode 树，调用 diff
import type { VNode } from './types';
import { diff } from './diff';

export function reconcile(vnode: VNode, container: HTMLElement) {
  diff(null, vnode, container);
}
