// fiber.ts
// =====================================================================
// Mini React Fiber 实现（带基础调度、双缓冲、Effect 分阶段、Hooks 集成）
// ---------------------------------------------------------------------
// 设计目标（当前阶段已实现）：
// 1. 数据结构：FiberNode 双缓冲 (current / workInProgress) + Flags 副作用标记
// 2. 渲染阶段拆分：beginWork -> completeWork 形成 effect list，最后 commitRoot
// 3. Diff 策略：支持 FunctionComponent / HostComponent / Text，children keyed 与线性复用
// 4. Hooks 融合：函数组件在 beginWork 内执行组件函数 + 收集 hooks（在 hooks.ts 实现）
// 5. Effect：区分 layout / passive；在 commit 后分别同步与异步执行；具备 destroy/create 两阶段
// 6. 调度：
//    - Lanes 简化优先级（user-blocking / high -> 同步；normal / low / idle -> 并发分片）
//    - 并发时间分片：requestIdleCallback + shouldYield + 预算 FRAME_BUDGET
//    - 新高优任务打断低优进行中的渲染，重新从根开始
// 7. 属性 / 事件更新：commit 阶段统一 diff 与 patch（updateHostComponentProps）
// 8. 删除：支持子树删除 + effect cleanup 顺序策略（parent-first / child-first）
// 9. 调试：debugConfig 控制 effect / schedule 日志、被动 effect flush 模式（宏/微任务）
// ---------------------------------------------------------------------
// 与真实 React 的缺失 / 差异：
// - 不支持优先级老化 / lane 合并策略 / Suspense / ErrorBoundary / Context / Ref / Fragment / Portal
// - 没有 Fiber 回退（如 render 中抛错对 alternate 回滚）
// - 没有 updateQueue / setState 合并，只有最简 scheduleRootUpdate
// - Passive effect 不含优先级隔离 / 与 commit root 分离（当前一次 root 提交后统一批处理）
// - 没有离屏模式、没有 profiler、没有 hydration
// =====================================================================

// Phase1+2(partial): Fiber 架构骨架 + 改进子节点调和 + Host props Update 提交
// 后续阶段在此基础上不断增量迭代
// ---------------------------------------------------------------------

import { prepareToUseHooks, finishHooks } from './hooks';
import type { VNode } from './types';

// ======================== 调试配置与日志 ===============================
export const debugConfig = {
  enable: true,                 // 总开关
  effect: {
    logLayout: true,            // 打印 layout effect 执行
    logPassive: true,           // 打印 passive effect 执行
    includeDetails: true,       // 输出统计对象
    cleanupOrder: 'parent-first' as 'parent-first' | 'child-first', // unmount cleanup 顺序
    passiveFlushMode: 'macro' as 'macro' | 'micro',                // passive flush 调度方式
  },
  schedule: { log: false }      // 调度阶段日志
};
function debugLog(label:string, info?:any){
  if(!debugConfig.enable) return;
  if(info!=null && debugConfig.effect.includeDetails){ console.log(`[fiber] ${label}`, info); }
  else console.log(`[fiber] ${label}`);
}

// ======================== 核心枚举 / 标记 =============================
export const FiberTag = { HostRoot:0, HostComponent:1, FunctionComponent:2, Text:3, Fragment:4 } as const;
export type FiberTagType = typeof FiberTag[keyof typeof FiberTag];
export const Flags = { NoFlags:0, Placement:1<<0, Update:1<<1, Deletion:1<<2 } as const;
export type FlagType = typeof Flags[keyof typeof Flags];

// ======================== Fiber 节点结构 ===============================
export interface FiberNode {
  tag: FiberTagType;            // 节点类型
  type: any;                    // 组件函数 / DOM 标签名
  key: any;                     // 用于 keyed diff
  stateNode: any;               // HostComponent/Text 对应真实 DOM；HostRoot = 容器
  return: FiberNode | null;     // 父 Fiber
  child: FiberNode | null;      // 第一个子 Fiber
  sibling: FiberNode | null;    // 兄弟 Fiber（单向链表）
  alternate: FiberNode | null;  // 双缓冲：current <-> workInProgress
  pendingProps: any;            // 本次 render 传入 props
  memoizedProps: any;           // 上一次 commit 确定的 props（用于比较）
  flags: FlagType;              // 本节点副作用标记
  subtreeFlags: FlagType;       // 子树聚合副作用（目前仅统计，不细化使用）
  effectNext: FiberNode | null; // effect list 单链表
  componentInstance?: any;      // legacy 兼容字段（旧 hooks 容器）
  hooks?: any[];                // hooks.ts 填充的 hooks 数组
  _hasPassive?: boolean;        // 预留：是否存在 passive effect
}

// ======================== Root / 全局状态 =============================
interface FiberRoot {
  container: HTMLElement;       // 容器 DOM
  current: FiberNode;           // 已提交树 (current fiber root)
  finishedWork: FiberNode | null; // 预留（当前直接 commit）
  firstEffect: FiberNode | null; // effect list 头
  lastEffect: FiberNode | null;  // effect list 尾
}

let root: FiberRoot | null = null;          // 全局唯一 root（当前实现单 root）
let workInProgress: FiberNode | null = null; // 正在构建的 fiber（depth-first）
let rootElement: VNode | null = null;        // 保存根 vnode（重新调度时复用）

// ======================== Lanes（简化优先级） ==========================
const Lanes = {
  NoLanes: 0,
  UserBlockingLane: 1 << 0,
  HighLane: 1 << 1,
  NormalLane: 1 << 2,
  LowLane: 1 << 3,
  IdleLane: 1 << 4
};
function mergeLanes(a:number,b:number){ return a|b; }
let pendingLanes = Lanes.NoLanes; // 等待处理的 lanes（新的更新合并进来）

// ======================== Fiber 创建与复用 ============================
function createFiber(tag: FiberTagType, pendingProps: any, key: any): FiberNode {
  return { tag, type: null, key, stateNode: null, return: null, child: null, sibling: null, alternate: null, pendingProps, memoizedProps: null, flags: Flags.NoFlags, subtreeFlags: Flags.NoFlags, effectNext: null, hooks: undefined };
}
function createWorkInProgress(current: FiberNode, pendingProps: any): FiberNode {
  // 双缓冲：使用 current.alternate 作为工作节点；若不存在则创建
  if (!current) throw new Error('createWorkInProgress: current is null');
  let wip = current.alternate;
  if (!wip) {
    wip = createFiber(current.tag, pendingProps, current.key);
    wip.stateNode = current.stateNode;
    wip.alternate = current;
    current.alternate = wip;
  } else {
    // 复位 flags / effectNext 以便重新收集
    wip.pendingProps = pendingProps;
    wip.flags = Flags.NoFlags;
    wip.subtreeFlags = Flags.NoFlags;
    wip.effectNext = null;
  }
  wip.type = current.type;
  return wip;
}

// ======================== 渲染入口（外部调用） ========================
export function renderRoot(vnode: VNode, container: HTMLElement) {
  // 将请求转交并发实现（内部自动判定是否同步）
  renderRootConcurrentInternal(vnode, container);
}

// ======================== 同步 workLoop（高优） ========================
function workLoopSync() {
  while (workInProgress) {
    performUnitOfWork(workInProgress);
  }
}

// 执行一个 Fiber 工作单元：beginWork -> (child?) or complete
function performUnitOfWork(fiber: FiberNode) {
  const next = beginWork(fiber);
  if (next) { workInProgress = next; return; }
  completeUnitOfWork(fiber);
}

// 向上回溯 completeWork，直到找到兄弟或回到根
function completeUnitOfWork(fiber: FiberNode) {
  let node: FiberNode | null = fiber;
  while (node) {
    completeWork(node); // 构建真实节点 / 收集副作用
    const sibling = node.sibling;
    if (sibling) { workInProgress = sibling; return; }
    node = node.return;
  }
  workInProgress = null; // 回到根，渲染阶段结束
}

// ======================== beginWork：生成/复用子树 ====================
function beginWork(fiber: FiberNode): FiberNode | null {
  switch (fiber.tag) {
    case FiberTag.HostRoot: {
      // HostRoot 的 pendingProps.children 挂载整个应用的 rootElement
      const rootChildren = fiber.pendingProps?.children || [];
      reconcileChildren(fiber, rootChildren);
      return fiber.child;
    }
    case FiberTag.FunctionComponent:
      return updateFunctionComponent(fiber);
    case FiberTag.HostComponent:
      return updateHostComponent(fiber);
    case FiberTag.Fragment:
      // Fragment 直接下放 children
      const fragChildren = fiber.pendingProps?.children || [];
      reconcileChildren(fiber, fragChildren);
      return fiber.child;
    case FiberTag.Text:
      return null;
    default:
      return null;
  }
}

// ======================== 辅助：浅比较（用于 bailout） ================
function shallowEqual(a:any,b:any){
  if (a===b) return true; if(!a||!b) return false;
  const ka=Object.keys(a), kb=Object.keys(b); if(ka.length!==kb.length) return false;
  for(const k of ka){ if(a[k]!==b[k]) return false; }
  return true;
}
function shallowEqualExceptChildren(a:any,b:any){
  if(a===b) return true; if(!a||!b) return false;
  const ka=Object.keys(a).filter(k=>k!=='children');
  const kb=Object.keys(b).filter(k=>k!=='children');
  if(ka.length!==kb.length) return false;
  for(const k of ka){ if(a[k]!==b[k]) return false; }
  return true;
}

// 克隆旧子树（bailout）
function cloneChildFibers(parentWip: FiberNode, currentParent: FiberNode | null): FiberNode | null {
  if (!currentParent) return null;
  let prevWip: FiberNode | null = null;
  let currentChild = currentParent.child;
  while (currentChild){
    const cloned = createWorkInProgress(currentChild, currentChild.pendingProps ?? currentChild.memoizedProps);
    cloned.return = parentWip;
    if (!prevWip) parentWip.child = cloned; else prevWip.sibling = cloned;
    prevWip = cloned;
    currentChild = currentChild.sibling;
  }
  return parentWip.child;
}

// ======================== FunctionComponent 更新 ======================
function updateFunctionComponent(fiber: FiberNode) {
  // Bailout：props 未变化且无更新相关 flags -> 直接克隆子树
  if (fiber.alternate && fiber.alternate.memoizedProps && shallowEqual(fiber.alternate.memoizedProps, fiber.pendingProps) && !(fiber.flags & (Flags.Update | Flags.Placement | Flags.Deletion))) {
    if (!fiber.hooks && fiber.alternate.hooks) fiber.hooks = fiber.alternate.hooks; // 复用 hooks 容器
    cloneChildFibers(fiber, fiber.alternate);
    return fiber.child; // 跳过重新执行组件函数
  }
  // 复用旧 hooks 引用（使第一次进入 hooks.ts 时看到旧数组，内部按索引更新）
  if (!fiber.hooks && fiber.alternate && fiber.alternate.hooks) {
    fiber.hooks = fiber.alternate.hooks;
  }
  // 进入 hooks 环境
  prepareToUseHooks(fiber);
  const props = fiber.pendingProps && typeof fiber.pendingProps === 'object' ? { ...fiber.pendingProps } : fiber.pendingProps;
  const vnode: VNode = fiber.type(props || {}); // 执行函数组件，返回子 VNode
  finishHooks();
  reconcileChildren(fiber, [vnode]);
  // 收集 effect：只要本组件 hooks 中有首次或依赖变化的 effect，就将该函数组件 Fiber 放入待处理队列
  const hooks = fiber.hooks || [];
  for (const h of hooks){
    if (h && h.__type==='effect' && (h.firstRun || h.depsChanged)) { pushEffectFiber(fiber); break; }
  }
  return fiber.child;
}

// ======================== HostComponent 更新 ==========================
function updateHostComponent(fiber: FiberNode) {
  const prev = fiber.alternate;
  const nextChildren = fiber.pendingProps?.children || [];
  // Bailout：除 children 外 props 浅相等 & children 引用一致（或都为空）
  if (prev && prev.memoizedProps && shallowEqualExceptChildren(prev.memoizedProps, fiber.pendingProps) ) {
    const prevChildren = prev.memoizedProps?.children || [];
    if (prevChildren === nextChildren || (Array.isArray(prevChildren) && Array.isArray(nextChildren) && prevChildren.length===0 && nextChildren.length===0)) {
      cloneChildFibers(fiber, prev);
      return fiber.child;
    }
  }
  const children = nextChildren;
  reconcileChildren(fiber, children);
  return fiber.child;
}

// ======================== children 调和 ================================
// wrapProps：将 child VNode 的 children 塞进 props 里，便于统一处理
function wrapProps(vnode: any) {
  if (!vnode) return {};
  const ch = vnode.children && vnode.children.length ? vnode.children : null;
  if (!ch) return vnode.props || {};
  return { ...(vnode.props || {}), children: vnode.children };
}

// reconcileChildren：支持 keyed & 非 keyed 两种模式
function reconcileChildren(returnFiber: FiberNode, children: any[]) {
  if (!children) children = [];
  if (!Array.isArray(children)) children = [children];
  // 规范化：将 Fragment vnode (type 是 Symbol 且描述为 'Fragment') 转换成内部标记
  children = children.map(c => {
    if (c && typeof c === 'object' && typeof c.type === 'symbol' && (c.type as any).description === 'Fragment') {
      // 包装为内部 Fragment fiber 所需的 props 结构
      return { ...c, __isFragment: true };
    }
    return c;
  });

  // 条件：所有子节点不是纯文本 & 存在至少一个非 null key -> keyed 模式
  const keyable = children.length > 0 && children.every(c => typeof c !== 'string' && typeof c !== 'number') && children.some(c => c && c.key != null);

  let oldFiber = returnFiber.alternate?.child || null;

  if (keyable) {
    // ---------- keyed diff ----------
    const oldKeyMap = new Map<any, FiberNode>();
    let of = oldFiber;
    let oldIndexCounter = 0;
    while (of) { if (of.key != null) { (of as any)._oldIndex = oldIndexCounter; oldKeyMap.set(of.key, of); } of = of.sibling; oldIndexCounter++; }

    let prevNewFiber: FiberNode | null = null;
    const used = new Set<any>();
    let lastPlacedIndex = -1; // 保持增量最长不动序列，减少无谓移动

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child == null) continue;
      let newFiber: FiberNode | null = null;
      if (typeof child === 'string' || typeof child === 'number') {
        newFiber = createFiber(FiberTag.Text, String(child), null);
        newFiber.flags |= Flags.Placement;
      } else {
        const matched = child.key != null ? oldKeyMap.get(child.key) : null;
        if (matched && matched.type === child.type) {
          // 复用旧 fiber
          const newPending = wrapProps(child);
          newFiber = createWorkInProgress(matched, newPending);
          newFiber.type = child.type;
          if (!shallowEqual(matched.memoizedProps, newPending)) newFiber.flags |= Flags.Update;
          // 移动检测：旧位置 < lastPlacedIndex -> 需要移动（标记 Placement）
          const oldIdx = (matched as any)._oldIndex ?? 0;
          if (oldIdx < lastPlacedIndex) {
            newFiber.flags |= Flags.Placement;
          } else {
            lastPlacedIndex = oldIdx;
          }
          used.add(child.key);
        } else {
          const wProps = wrapProps(child);
          const tag = child.__isFragment ? FiberTag.Fragment : (typeof child.type === 'function' ? FiberTag.FunctionComponent : FiberTag.HostComponent);
          newFiber = createFiber(tag, wProps, child.key);
          newFiber.type = child.__isFragment ? null : child.type;
          newFiber.flags |= Flags.Placement;
        }
      }
      newFiber.return = returnFiber;
      if (!prevNewFiber) returnFiber.child = newFiber; else prevNewFiber.sibling = newFiber;
      prevNewFiber = newFiber;
    }
    // 删除未复用的旧 fiber
    oldKeyMap.forEach((f, k) => { if (!used.has(k)) { f.flags |= Flags.Deletion; pushEffect(f); } });
    return; // keyed 结束
  }

  // ---------- 非 keyed 线性 diff ----------
  let prevNew: FiberNode | null = null;
  let old = oldFiber;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child == null) continue;
    let newFiber: FiberNode | null = null;

    if (typeof child === 'string' || typeof child === 'number') {
      if (old && old.tag === FiberTag.Text) {
        // 复用 Text Fiber
        newFiber = createWorkInProgress(old, null);
        if (old.stateNode && (old.stateNode as Text).data !== String(child)) {
          newFiber.flags |= Flags.Update; newFiber.pendingProps = String(child);
        }
      } else {
        newFiber = createFiber(FiberTag.Text, String(child), null);
        newFiber.flags |= Flags.Placement;
      }
    } else { // VNode
      if (old && old.type === child.type && old.key === child.key) {
        const newPending = wrapProps(child);
        newFiber = createWorkInProgress(old, newPending);
        newFiber.type = child.type;
        if (!shallowEqual(old.memoizedProps, newPending)) newFiber.flags |= Flags.Update;
      } else {
        const wProps = wrapProps(child);
        const tag = child.__isFragment ? FiberTag.Fragment : (typeof child.type === 'function' ? FiberTag.FunctionComponent : FiberTag.HostComponent);
        newFiber = createFiber(tag, wProps, child.key);
        newFiber.type = child.__isFragment ? null : child.type;
        newFiber.flags |= Flags.Placement;
      }
    }
    if (old) old = old.sibling; // 线性前进
    newFiber.return = returnFiber;
    if (!prevNew) returnFiber.child = newFiber; else prevNew.sibling = newFiber;
    prevNew = newFiber;
  }
  // 多余旧 fiber 标记删除
  while (old) { old.flags |= Flags.Deletion; pushEffect(old); old = old.sibling; }
}

// ======================== completeWork：构建 DOM / 收集 flags =========
function completeWork(fiber: FiberNode) {
  switch (fiber.tag) {
    case FiberTag.HostComponent:
      if (!fiber.stateNode) {
        const el = document.createElement(fiber.type);
        fiber.stateNode = el;
        // 初次：设置所有 props
        updateHostComponentProps(el, {}, fiber.pendingProps || {});
      }
      fiber.memoizedProps = fiber.pendingProps;
      bubbleEffects(fiber);
      break;
    case FiberTag.Text:
      if (!fiber.stateNode) {
        fiber.stateNode = document.createTextNode(fiber.pendingProps);
      } else if (fiber.flags & Flags.Update) {
        (fiber.stateNode as Text).data = fiber.pendingProps;
      }
      bubbleEffects(fiber);
      break;
    case FiberTag.FunctionComponent:
      bubbleEffects(fiber);
      break;
    case FiberTag.HostRoot:
      bubbleEffects(fiber);
      break;
    case FiberTag.Fragment:
      bubbleEffects(fiber); // 不创建 DOM
      break;
  }
  // 有自身副作用则放入 effect list
  if (fiber.flags & (Flags.Placement | Flags.Update | Flags.Deletion)) pushEffect(fiber);
}

// 向上聚合 subtreeFlags（当前仅统计，可用于未来快速跳过无副作用子树）
function bubbleEffects(fiber: FiberNode) {
  let subtree = Flags.NoFlags;
  let child = fiber.child;
  while (child) {
    subtree |= child.subtreeFlags | child.flags;
    child = child.sibling;
  }
  fiber.subtreeFlags = subtree;
}

// ======================== effect list 构建 =============================
function pushEffect(fiber: FiberNode) {
  if (!root) return;
  if (!root.firstEffect) root.firstEffect = fiber; else (root.lastEffect as FiberNode).effectNext = fiber;
  root.lastEffect = fiber;
}

// ----------------- 记录有 layout/passive effect 的函数组件 fiber -------
const pendingLayoutEffects: FiberNode[] = []; // 同步执行
const pendingPassiveEffects: FiberNode[] = []; // 异步批量
let passiveFlushScheduled = false; // 防抖标记
let passiveFlushId = 0;            // flush 批次 id
function pushEffectFiber(fiber: FiberNode){
  if (fiber.hooks){
    let hasLayout = false; let hasPassive = false;
    for (const h of fiber.hooks){
      if (!h || h.__type!=='effect') continue;
      if (h.firstRun || h.depsChanged){
        if (h.kind === 'layout') hasLayout = true; else hasPassive = true;
      }
    }
    if (hasLayout && !pendingLayoutEffects.includes(fiber)) pendingLayoutEffects.push(fiber);
    if (hasPassive && !pendingPassiveEffects.includes(fiber)) pendingPassiveEffects.push(fiber);
  }
}

// ======================== layout effects 同步执行 ======================
function flushLayoutEffects(){
  let fiberCount=0, effectCount=0;
  for (const fiber of pendingLayoutEffects){
    fiberCount++;
    const hooks = fiber.hooks || [];
    for (const h of hooks){
      if(!h || h.__type!=='effect' || h.kind!=='layout') continue;
      if (h.firstRun || h.depsChanged){
        effectCount++;
        if (!h.firstRun && h.destroy){ try{ h.destroy(); }catch(e){ console.error('layout destroy error', e); } }
        let destroy:any; let threw=false;
        try { destroy = h.create(); } catch(e){ threw=true; console.error('layout create error', e); }
        h.destroy = typeof destroy === 'function' ? destroy : null;
        h.firstRun = false; h.depsChanged = false;
        if (threw) h.destroy = null;
      }
    }
  }
  if (fiberCount || effectCount) debugLog('flush layout effects', { fibers:fiberCount, effects:effectCount });
  pendingLayoutEffects.length = 0;
}

// ======================== passive effects 异步批处理 ==================
function flushPassiveEffects(){
  if (!pendingPassiveEffects.length) { passiveFlushScheduled = false; return; }
  const batchId = ++passiveFlushId;
  const start = performance.now();
  let fibers=0, destroyCount=0, createCount=0;
  if (debugConfig.effect.logPassive) debugLog('passive phase (destroy)', { batch:batchId, pending:persistentPassiveCountSnapshot() });
  // 1. destroy 阶段（保证先清理旧资源）
  for (const fiber of pendingPassiveEffects){
    fibers++;
    const hooks = fiber.hooks || [];
    for (const h of hooks){
      if (!h || h.__type !== 'effect' || h.kind!=='passive') continue;
      if ((h.firstRun || h.depsChanged) && !h.firstRun && h.destroy){
        destroyCount++;
        try { h.destroy(); } catch(e){ console.error('passive destroy error', e); }
        h.destroy = null;
      }
    }
  }
  if (debugConfig.effect.logPassive) debugLog('passive phase (create)', { batch:batchId });
  // 2. create 阶段
  for (const fiber of pendingPassiveEffects){
    const hooks = fiber.hooks || [];
    for (const h of hooks){
      if (!h || h.__type !== 'effect' || h.kind!=='passive') continue;
      if (h.firstRun || h.depsChanged){
        let destroy:any; let threw=false;
        try { destroy = h.create(); createCount++; } catch(e){ threw=true; console.error('passive create error', e); }
        h.destroy = typeof destroy === 'function' ? destroy : null;
        h.firstRun = false; h.depsChanged = false;
        if (threw) h.destroy = null;
      }
    }
  }
  pendingPassiveEffects.length = 0;
  passiveFlushScheduled = false;
  if (debugConfig.effect.logPassive) debugLog('flush passive effects', { batch:batchId, fibers, destroy:destroyCount, create:createCount, duration: +(performance.now()-start).toFixed(2)+'ms' });
}
// 统计待执行 passive count（调试用）
function persistentPassiveCountSnapshot(){
  let count=0; for (const f of pendingPassiveEffects){ if(!f.hooks) continue; for (const h of f.hooks) if(h && h.__type==='effect' && h.kind==='passive' && (h.firstRun || h.depsChanged)) count++; }
  return count;
}

// ======================== unmount cleanup 顺序策略 ====================
function runPassiveCleanupOnFiber(fiber: FiberNode){
  if (fiber.tag === FiberTag.FunctionComponent && fiber.hooks){
    for (const h of fiber.hooks){
      if (h && h.__type==='effect' && h.destroy){
        try { h.destroy(); } catch(e){ console.error('effect unmount destroy error', e); }
        h.destroy = null;
      }
    }
  }
}
function cleanupPassiveEffects(fiber: FiberNode){
  if (debugConfig.effect.cleanupOrder === 'child-first') {
    let child = fiber.child; while (child){ cleanupPassiveEffects(child); child = child.sibling; }
    runPassiveCleanupOnFiber(fiber);
  } else { // parent-first
    runPassiveCleanupOnFiber(fiber);
    let child = fiber.child; while (child){ cleanupPassiveEffects(child); child = child.sibling; }
  }
}

// ======================== 提交阶段 commitRoot ========================
function commitRoot(finished: FiberNode | null) {
  if (!root) return;
  // 1. 遍历 effect list 执行 Placement / Update / Deletion
  let effect = root.firstEffect;
  while (effect) {
    commitEffect(effect);
    effect = effect.effectNext;
  }
  // 2. 切换 current 树
  if (finished) root.current = finished;
  // 3. 清空 effect list
  root.firstEffect = root.lastEffect = null;
  // 4. 执行 layout effects
  try { flushLayoutEffects(); } catch(e){ console.error('flushLayoutEffects error', e); }
  // 5. 调度 passive effects（异步）
  if (pendingPassiveEffects.length && !passiveFlushScheduled){
    schedulePassiveFlush();
  }
}
function schedulePassiveFlush(){
  if (passiveFlushScheduled) return;
  passiveFlushScheduled = true;
  const schedule = debugConfig.effect.passiveFlushMode === 'micro'
    ? (fn:Function)=>Promise.resolve().then(()=>fn())
    : (fn:Function)=>setTimeout(()=>fn(),0);
  schedule(()=>{ try { flushPassiveEffects(); } catch(e){ console.error('flushPassiveEffects error', e); } });
}

// ======================== 单个 effect 处理 ============================
function commitEffect(fiber: FiberNode) {
  if (fiber.flags & Flags.Placement) commitPlacement(fiber);
  if (fiber.flags & Flags.Update) commitUpdate(fiber);
  if (fiber.flags & Flags.Deletion) commitDeletion(fiber);
}

// 找到祖先 Host DOM（用于插入/删除）
function findHostParent(fiber: FiberNode): HTMLElement | null {
  let parent = fiber.return;
  while (parent) {
    if (parent.tag === FiberTag.HostComponent) return parent.stateNode;
    if (parent.tag === FiberTag.HostRoot) return parent.stateNode;
    parent = parent.return;
  }
  return null;
}

// 插入（深度遍历找到所有 host 节点追加）
function commitPlacement(fiber: FiberNode) {
  const parentDom = findHostParent(fiber);
  if (!parentDom) return;
  if (fiber.tag === FiberTag.HostComponent || fiber.tag === FiberTag.Text) {
    parentDom.appendChild(fiber.stateNode);
  } else {
    let child = fiber.child;
    while (child) { commitPlacement(child); child = child.sibling; }
  }
}

// 更新（HostComponent 重新 diff props）
function commitUpdate(fiber: FiberNode) {
  if (fiber.tag === FiberTag.HostComponent) {
    const dom = fiber.stateNode as HTMLElement;
    updateHostComponentProps(dom, fiber.alternate?.memoizedProps || {}, fiber.pendingProps || {});
    fiber.memoizedProps = fiber.pendingProps;
  }
  // Text 文本已在 completeWork 中直接写入
}

// 删除：执行 cleanup -> 移除所有 host 节点
function commitDeletion(fiber: FiberNode) {
  cleanupPassiveEffects(fiber); // effect 清理
  const parentDom = findHostParent(fiber);
  if (!parentDom) return;
  removeHostNodes(fiber, parentDom);
}
function removeHostNodes(fiber: FiberNode, parentDom: HTMLElement) {
  if (fiber.tag === FiberTag.HostComponent || fiber.tag === FiberTag.Text) {
    if (fiber.stateNode && parentDom.contains(fiber.stateNode)) parentDom.removeChild(fiber.stateNode);
  } else {
    let child = fiber.child; while (child) { removeHostNodes(child, parentDom); child = child.sibling; }
  }
}

// ======================== DOM 属性 / 事件 Diff ========================
function updateHostComponentProps(el: HTMLElement, oldProps: any, newProps: any) {
  // 先处理 style 对象：转换为行内样式 diff
  function applyStylePatch(oldStyle: any, newStyle: any) {
    if (!oldStyle && !newStyle) return;
    const style = (el as any).style; if (!style) return;
    oldStyle = oldStyle || {}; newStyle = newStyle || {};
    // 移除
    for (const k in oldStyle) { if (!(k in newStyle)) { style[k] = ''; } }
    // 添加或更新
    for (const k in newStyle) { if (oldStyle[k] !== newStyle[k]) { style[k] = newStyle[k]; } }
  }
  const oldStyle = oldProps?.style && typeof oldProps.style === 'object' ? oldProps.style : null;
  const newStyle = newProps?.style && typeof newProps.style === 'object' ? newProps.style : null;
  // style 对象 diff
  if (oldStyle || newStyle) applyStylePatch(oldStyle, newStyle);
  // 新增：支持 style 传入字符串（JSX 中 style="..."），旧实现会直接跳过导致样式不生效
  const oldStyleStr = typeof oldProps?.style === 'string' ? oldProps.style : null;
  const newStyleStr = typeof newProps?.style === 'string' ? newProps.style : null;
  if (oldStyleStr && !newStyleStr) { // 从字符串移除
    el.removeAttribute('style');
  }
  if (newStyleStr) {
    if (oldStyleStr !== newStyleStr) {
      // 直接覆盖（与 React 不同，这里简单实现，无需 diff）
      el.setAttribute('style', newStyleStr);
    }
  }
  // 若从 字符串 -> 对象，前面对象 diff 已应用，需要确保不残留旧字符串：已在旧字符串存在且新不是字符串时 removeAttribute 处理

  // 移除旧属性/事件
  for (const key in oldProps) {
    if (key === 'children' || key === 'key' || key === 'style') continue;
    if (!(key in newProps)) {
      if (/^on[A-Z]/.test(key)) {
        const evt = key.slice(2).toLowerCase();
        el.removeEventListener(evt, oldProps[key]);
      } else {
        (el as any)[key] !== undefined ? (el as any)[key] = '' : el.removeAttribute(key);
      }
    }
  }
  // 添加 / 更新
  for (const key in newProps) {
    if (key === 'children' || key === 'key' || key === 'style') continue;
    const next = newProps[key]; const prev = oldProps[key];
    if (prev === next) continue;
    if (/^on[A-Z]/.test(key)) {
      const evt = key.slice(2).toLowerCase();
      if (prev) el.removeEventListener(evt, prev);
      el.addEventListener(evt, next);
    } else if ((el as any)[key] !== undefined) {
      (el as any)[key] = next;
    } else {
      el.setAttribute(key, next);
    }
  }
}

// ======================== 并发渲染（Phase5） ==========================
// 高优 (user-blocking / high) -> 同步；低优 -> 分片 + 可中断
let isRenderingConcurrent = false;
let currentWipRoot: FiberNode | null = null;
const FRAME_BUDGET = 5; // 单帧时间片预算 (ms)

// lane 优先级枚举顺序（从高到低）
const LanePriorityOrder = [
  1 << 0, // UserBlockingLane
  1 << 1, // HighLane
  1 << 2, // NormalLane
  1 << 3, // LowLane
  1 << 4  // IdleLane
];
function getHighestPriorityLane(lanes:number){
  for(const l of LanePriorityOrder){ if(lanes & l) return l; }
  return 0;
}
function isSyncLane(lane:number){
  return lane === (1<<0) || lane === (1<<1); // 两个高优级同步
}

let frameStart = 0;
function shouldYield(deadline?:any){
  if (deadline && typeof deadline.timeRemaining === 'function') {
    if (deadline.timeRemaining() <= 0) return true;
  }
  return (performance.now() - frameStart) >= FRAME_BUDGET;
}

function requestConcurrentCallback(){
  if (typeof (window as any).requestIdleCallback === 'function') {
    (window as any).requestIdleCallback(concurrentWorkLoop);
  } else {
    setTimeout(()=>concurrentWorkLoop({ timeRemaining:()=>0 }),1);
  }
}

function startConcurrentWorkLoop(){
  if (isRenderingConcurrent) return; // 已在进行
  isRenderingConcurrent = true;
  requestConcurrentCallback();
}

// 并发循环：执行部分单元，时间片耗尽 -> 让出，直到构建完成
function concurrentWorkLoop(deadline:any){
  frameStart = performance.now();
  while (workInProgress && !shouldYield(deadline)){
    performUnitOfWork(workInProgress);
  }
  if (!workInProgress) {
    // 完成 -> 提交
    isRenderingConcurrent = false;
    commitRoot(currentWipRoot);
  } else {
    // 未完成 -> 下一帧
    requestConcurrentCallback();
  }
}

// 内部：根据 lane 选择同步或并发路径
function renderRootConcurrentInternal(vnode: VNode, container: HTMLElement) {
  if (!root) {
    const hostRoot = createFiber(FiberTag.HostRoot, { children: [vnode] }, null);
    hostRoot.stateNode = container;
    root = { container, current: hostRoot, finishedWork: null, firstEffect: null, lastEffect: null };
  }
  // 每次更新：刷新 rootElement 与 root.current 的 pendingProps.children
  rootElement = vnode;
  root.current.pendingProps = { children: [vnode] };
  const activeLanes = pendingLanes || (1<<2);
  const highest = getHighestPriorityLane(activeLanes);
  pendingLanes = Lanes.NoLanes;
  workInProgress = createWorkInProgress(root.current, root.current.pendingProps);
  currentWipRoot = workInProgress;
  if (isSyncLane(highest)) {
    workLoopSync();
    commitRoot(currentWipRoot);
  } else {
    startConcurrentWorkLoop();
  }
}

// ======================== 对外：调度根更新 ============================
export function scheduleRootUpdate(lane?: number) {
  if (debugConfig.schedule.log) debugLog('scheduleRootUpdate', { lane, pendingLanesBefore: pendingLanes });
  if (lane != null) pendingLanes = mergeLanes(pendingLanes, lane);
  // 若正在并发渲染且来高优更新 -> 直接打断放弃当前 WIP，转同步
  if (isRenderingConcurrent) {
    const highestIncoming = getHighestPriorityLane(pendingLanes);
    if (isSyncLane(highestIncoming)) {
      workInProgress = null; // 放弃当前构建
      isRenderingConcurrent = false;
    }
  }
  if (root && rootElement) {
    try { renderRoot(rootElement, root.container); } catch(e){ console.error(e); }
  } else {
    // 初次：若外部还未调用 renderRoot 但已有 rootElement（理论上不走到）
    if (rootElement && (rootElement as any).type && typeof document !== 'undefined') {
      const containerEl = (root as any)?.container || document.getElementById('root');
      if (containerEl) renderRoot(rootElement, containerEl as any);
    }
  }
}

// ======================== 结尾：Phase5 additions end ===================
