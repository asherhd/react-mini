// diff.ts
// 虚拟 DOM diff 算法与挂载逻辑
// 步骤2：根据虚拟DOM类型递归挂载或更新真实DOM
// 详见流程图 C->D->E/F->I/J
import type { VNode } from './types';
import { setCurrentComponent, resetCurrentComponent, currentComponent } from './hooks';

// 统一执行 effects 的函数
function executeEffects(componentInstance: any) {
  if (componentInstance._hasEffect) {
    const hooks = componentInstance.hooks;
    hooks.forEach((h: any) => {
      if (h && typeof h[0] === 'function' && h[3]) {
        if (h[2]) h[2](); // cleanup
        h[2] = h[0](); // effect
        h[3] = false;
      }
    });
    componentInstance._hasEffect = false;
  }
}

export function diff(oldVNode: VNode | null, newVNode: VNode, container: HTMLElement) {
  if (!oldVNode) {
    mount(newVNode, container);
  } else if (oldVNode.type !== newVNode.type) {
    // 类型不同，直接替换
    const newEl = document.createElement(typeof newVNode.type === 'string' ? newVNode.type : 'div');
    container.replaceChild(newEl, oldVNode.dom as Node);
    mount(newVNode, container);
  } else if (typeof newVNode.type === 'string') {
    // 标签节点，更新属性和递归子节点（含快速路径 + keyed diff）
    const el = oldVNode.dom as HTMLElement;
    newVNode.dom = el;
    // 快速路径：props & children 引用均未变，直接复用
    if (oldVNode.props === newVNode.props && oldVNode.children === newVNode.children) return;
    // 更新属性
    updateProps(el, oldVNode.props || {}, newVNode.props || {});
    const oldChildren = oldVNode.children || [];
    const newChildren = newVNode.children || [];

    // 快速路径：纯文本且内容完全相同
    if (
      oldChildren.length === newChildren.length &&
      oldChildren.length > 0 &&
      oldChildren.every(c => typeof c === 'string') &&
      newChildren.every(c => typeof c === 'string') &&
      oldChildren.join('\u0000') === newChildren.join('\u0000')
    ) {
      return;
    }

    // keyed diff：当旧/新子节点全部为带 key 的非文本节点时启用
    const allOldKeyed = oldChildren.length > 0 && oldChildren.every(c => typeof c !== 'string' && c && c.key != null);
    const allNewKeyed = newChildren.length > 0 && newChildren.every(c => typeof c !== 'string' && c && c.key != null);

    if (allOldKeyed && allNewKeyed) {
      // 建立 old key -> vnode 映射
      const oldMap = new Map<any, { vnode: any; index: number }>();
      oldChildren.forEach((c: any, i: number) => oldMap.set(c.key, { vnode: c, index: i }));
      const usedOldKeys = new Set<any>();

      // 首先 diff / 挂载 新集合
      for (let i = 0; i < newChildren.length; i++) {
        const newChild: any = newChildren[i];
        const rec = oldMap.get(newChild.key);
        if (rec) {
          // 复用并递归 diff
            diff(rec.vnode, newChild, el);
          usedOldKeys.add(newChild.key);
        } else {
          // 新增
          mount(newChild, el);
        }
      }
      // 移除未复用的旧节点
      oldChildren.forEach((c: any) => {
        if (!usedOldKeys.has(c.key) && c.dom) {
          try { el.removeChild(c.dom as Node); } catch {}
        }
      });
      // 按新顺序重排 DOM（最简 O(n) 遍历 + insertBefore 校正）
      let prev: Node | null = null;
      for (let i = 0; i < newChildren.length; i++) {
        const vnode: any = newChildren[i];
        const node = vnode.dom as Node;
        if (!node) continue;
        if (!prev) {
          if (el.firstChild !== node) el.insertBefore(node, el.firstChild);
        } else if (prev.nextSibling !== node) {
          el.insertBefore(node, prev.nextSibling);
        }
        prev = node;
      }
      return; // keyed 分支结束
    }

    // 子节点 diff（简易按索引）
    const maxLen = Math.max(oldChildren.length, newChildren.length);
    for (let i = 0; i < maxLen; i++) {
      const oldChild = oldChildren[i];
      const newChild = newChildren[i];
      if (!oldChild && newChild) {
        // 新增
        if (typeof newChild === 'string') {
          el.appendChild(document.createTextNode(newChild));
        } else {
          mount(newChild, el);
        }
      } else if (oldChild && !newChild) {
        // 删除
        if (typeof oldChild !== 'string' && oldChild.dom) {
          el.removeChild(oldChild.dom as Node);
        } else if (typeof oldChild === 'string') {
          if (el.childNodes[i]) el.removeChild(el.childNodes[i]);
        }
      } else if (oldChild && newChild) {
        if (typeof oldChild === 'string' && typeof newChild === 'string') {
          if (oldChild !== newChild) {
            el.childNodes[i].textContent = newChild;
          }
        } else if (typeof oldChild !== 'string' && typeof newChild !== 'string') {
          diff(oldChild, newChild, el);
        } else if (typeof oldChild !== 'string' && typeof newChild === 'string') {
          // 元素 -> 文本
          el.replaceChild(document.createTextNode(newChild), oldChild.dom as Node);
        } else if (typeof oldChild === 'string' && typeof newChild !== 'string') {
          // 文本 -> 元素
          const placeholder = el.childNodes[i];
          mount(newChild, el);
          if (placeholder) el.replaceChild(newChild.dom as Node, placeholder);
        }
      }
    }
  } else if (typeof newVNode.type === 'function') {
    // 函数组件，递归 diff 子树，始终复用旧的 componentInstance
    const componentInstance = oldVNode.componentInstance;
    if (componentInstance) {
      setCurrentComponent(componentInstance);
      currentComponent.hooks = componentInstance.hooks;
      const oldChildVNode = oldVNode.childVNode;
      const newChildVNode = (newVNode.type as Function)(newVNode.props);
      newChildVNode.hooks = currentComponent.hooks;
      resetCurrentComponent();
      newVNode.dom = newChildVNode.dom;
      newVNode.componentInstance = componentInstance;
      newVNode.childVNode = newChildVNode;
      componentInstance.hooks = newChildVNode.hooks || [];
      diff(oldChildVNode ?? null, newChildVNode, container);
      // effects 不在这里执行，而是在 update 方法中统一执行
    }
  }
}

function mount(vnode: VNode, container: HTMLElement) {
  if (!vnode) return;
  if (typeof vnode.type === 'string') {
    // 标签节点：创建真实DOM
    const el = document.createElement(vnode.type);
    vnode.dom = el;
    // 设置属性和事件
    if (vnode.props) {
      for (const key in vnode.props) {
        if (key !== 'key') {
          if (/^on[A-Z]/.test(key)) {
            const eventName = key.slice(2).toLowerCase();
            el.addEventListener(eventName, vnode.props[key]);
          } else if (key in el) {
            (el as any)[key] = vnode.props[key];
          } else {
            el.setAttribute(key, vnode.props[key]);
          }
        }
      }
    }
    // 递归挂载子节点
    vnode.children.forEach(child => {
      if (typeof child === 'string') {
        el.appendChild(document.createTextNode(child));
      } else {
        mount(child, el);
      }
    });
    container.appendChild(el);
  } else if (typeof vnode.type === 'function') {
    // 只在首次渲染时挂载
    if (!vnode.componentInstance) {
      const componentInstance: any = {
        hooks: [],
        update: () => {
          setCurrentComponent(componentInstance);
          currentComponent.hooks = componentInstance.hooks;
          const newChildVNode = (vnode.type as Function)(vnode.props);
          newChildVNode.hooks = currentComponent.hooks;
          resetCurrentComponent();
          diff(vnode.childVNode ?? null, newChildVNode, vnode.dom?.parentNode as HTMLElement);
          vnode.childVNode = newChildVNode;
          vnode.dom = newChildVNode.dom;
          componentInstance.hooks = newChildVNode.hooks;
          executeEffects(componentInstance);
        }
      };
      vnode.componentInstance = componentInstance;
      setCurrentComponent(componentInstance);
      const childVNode = (vnode.type as Function)(vnode.props);
      childVNode.hooks = currentComponent.hooks;
      resetCurrentComponent();
      vnode.dom = childVNode.dom;
      vnode.childVNode = childVNode;
      mount(childVNode, container);
          executeEffects(componentInstance);
    }
  }
}

function updateProps(el: HTMLElement, oldProps: any, newProps: any) {
  // 移除旧属性（事件只在不存在时移除，存在但变化的在后面单独处理）
  for (const key in oldProps) {
    if (!(key in newProps)) {
      if (/^on[A-Z]/.test(key)) {
        const eventName = key.slice(2).toLowerCase();
        el.removeEventListener(eventName, oldProps[key]);
      } else if (key !== 'key') {
        el.removeAttribute(key);
      }
    }
  }
  // 设置 / 更新 新属性
  for (const key in newProps) {
    if (key !== 'key') {
      if (/^on[A-Z]/.test(key)) {
        const eventName = key.slice(2).toLowerCase();
        const prev = oldProps[key];
        const next = newProps[key];
        if (prev !== next) {
          if (prev) el.removeEventListener(eventName, prev);
          el.addEventListener(eventName, next);
        }
      } else if (key in el) {
        (el as any)[key] = newProps[key];
      } else {
        el.setAttribute(key, newProps[key]);
      }
    }
  }
}
