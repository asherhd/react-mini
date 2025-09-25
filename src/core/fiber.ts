// fiber.ts
// Phase1+2(partial): Fiber 架构骨架 + 改进子节点调和 + Host props Update 提交
// 目标：更优 children 复用（keyed）+ 属性/事件差异在 commit 阶段处理
// import { setCurrentComponent, resetCurrentComponent, currentComponent } from './hooks'; // 移除未使用导入
// 新增导入 Phase3 hooks 融合 API
import { prepareToUseHooks, finishHooks } from './hooks';
import type { VNode } from './types';

// ==== 调试配置 (Phase6+ 扩展) ====
export const debugConfig = {
  enable: true,                 // 总开关
  effect: {
    logLayout: true,            // 打印 layout effect 执行
    logPassive: true,           // 打印 passive effect 执行
    includeDetails: true,       // 是否输出统计详情对象
    cleanupOrder: 'parent-first' as 'parent-first' | 'child-first', // effect destroy 顺序策略
    passiveFlushMode: 'macro' as 'macro' | 'micro', // passive flush 调度：macro=setTimeout 0；micro=Promise
  },
  schedule: { log: false }
};
function debugLog(label:string, info?:any){
  if(!debugConfig.enable) return;
  if(info!=null && debugConfig.effect.includeDetails){ console.log(`[fiber] ${label}`, info); }
  else console.log(`[fiber] ${label}`);
}

// Fiber Tag
export const FiberTag = { HostRoot:0, HostComponent:1, FunctionComponent:2, Text:3 } as const;
export type FiberTagType = typeof FiberTag[keyof typeof FiberTag];
// Flags
export const Flags = { NoFlags:0, Placement:1<<0, Update:1<<1, Deletion:1<<2 } as const;
export type FlagType = typeof Flags[keyof typeof Flags];

export interface FiberNode {
  tag: FiberTagType;
  type: any;
  key: any;
  stateNode: any; // DOM 或容器
  return: FiberNode | null;
  child: FiberNode | null;
  sibling: FiberNode | null;
  alternate: FiberNode | null; // 双缓冲
  pendingProps: any; // 本次渲染输入
  memoizedProps: any; // 上次提交已确定的 props
  flags: FlagType;
  subtreeFlags: FlagType;
  effectNext: FiberNode | null;
  componentInstance?: any; // 函数组件 hooks 容器 (legacy 兼容)
  hooks?: any[]; // Phase3: hooks 存储
  _hasPassive?: boolean; // 是否包含待执行的 passive effect
}

interface FiberRoot {
  container: HTMLElement;
  current: FiberNode; // 已提交树
  finishedWork: FiberNode | null;
  firstEffect: FiberNode | null;
  lastEffect: FiberNode | null;
}

let root: FiberRoot | null = null;
let workInProgress: FiberNode | null = null;
let rootElement: VNode | null = null; // 保存根 vnode

// Lane 定义（简单位掩码）
const Lanes = {
  NoLanes: 0,
  UserBlockingLane: 1 << 0,
  HighLane: 1 << 1,
  NormalLane: 1 << 2,
  LowLane: 1 << 3,
  IdleLane: 1 << 4
};
function mergeLanes(a:number,b:number){ return a|b; }
let pendingLanes = Lanes.NoLanes;

function createFiber(tag: FiberTagType, pendingProps: any, key: any): FiberNode {
  return { tag, type: null, key, stateNode: null, return: null, child: null, sibling: null, alternate: null, pendingProps, memoizedProps: null, flags: Flags.NoFlags, subtreeFlags: Flags.NoFlags, effectNext: null, hooks: undefined };
}

function createWorkInProgress(current: FiberNode, pendingProps: any): FiberNode {
  if (!current) throw new Error('createWorkInProgress: current is null');
  let wip = current.alternate;
  if (!wip) {
    wip = createFiber(current.tag, pendingProps, current.key);
    wip.stateNode = current.stateNode;
    wip.alternate = current;
    current.alternate = wip;
  } else {
    wip.pendingProps = pendingProps;
    wip.flags = Flags.NoFlags;
    wip.subtreeFlags = Flags.NoFlags;
    wip.effectNext = null;
  }
  wip.type = current.type;
  return wip;
}

export function renderRoot(vnode: VNode, container: HTMLElement) {
  // 调用并发实现（Phase5）
  renderRootConcurrentInternal(vnode, container);
}

function workLoopSync() {
  while (workInProgress) {
    performUnitOfWork(workInProgress);
  }
}

function performUnitOfWork(fiber: FiberNode) {
  const next = beginWork(fiber);
  if (next) { workInProgress = next; return; }
  completeUnitOfWork(fiber);
}

function completeUnitOfWork(fiber: FiberNode) {
  let node: FiberNode | null = fiber;
  while (node) {
    completeWork(node);
    const sibling = node.sibling;
    if (sibling) { workInProgress = sibling; return; }
    node = node.return;
  }
  workInProgress = null;
}

function beginWork(fiber: FiberNode): FiberNode | null {
  switch (fiber.tag) {
    case FiberTag.HostRoot:
      // root.pendingProps 里存的是根 vnode 的 props；根 VNode 的 children 通过 reconcileChildren 继续下发
      const rootVNode = fiber.pendingProps && (rootElement as any);
      const rootChildren = rootVNode ? rootVNode.children : [];
      reconcileChildren(fiber, rootChildren);
      return fiber.child;
    case FiberTag.FunctionComponent:
      return updateFunctionComponent(fiber);
    case FiberTag.HostComponent:
      return updateHostComponent(fiber);
    case FiberTag.Text:
      return null;
    default:
      return null;
  }
}

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

function updateFunctionComponent(fiber: FiberNode) {
  // Bailout: props 未变化且无显式更新标记（Update/Placement/Deletion），直接克隆子树
  if (fiber.alternate && fiber.alternate.memoizedProps && shallowEqual(fiber.alternate.memoizedProps, fiber.pendingProps) && !(fiber.flags & (Flags.Update | Flags.Placement | Flags.Deletion))) {
    // 复用 hooks（指针复用即可）
    if (!fiber.hooks && fiber.alternate.hooks) fiber.hooks = fiber.alternate.hooks;
    cloneChildFibers(fiber, fiber.alternate);
    return fiber.child; // 不进入重新计算，跳过 beginWork 子树
  }
  // Phase3 hooks：复用旧 hooks 引用
  if (!fiber.hooks && fiber.alternate && fiber.alternate.hooks) {
    fiber.hooks = fiber.alternate.hooks;
  }
  // 进入 hooks 环境
  prepareToUseHooks(fiber);
  const props = fiber.pendingProps && typeof fiber.pendingProps === 'object' ? { ...fiber.pendingProps } : fiber.pendingProps;
  const vnode: VNode = fiber.type(props || {});
  finishHooks();
  reconcileChildren(fiber, [vnode]);
  // 收集 effect 变化
  const hooks = fiber.hooks || [];
  for (const h of hooks){
    if (h && h.__type==='effect' && (h.firstRun || h.depsChanged)) { pushEffectFiber(fiber); break; }
  }
  return fiber.child;
}

function updateHostComponent(fiber: FiberNode) {
  const prev = fiber.alternate;
  const nextChildren = fiber.pendingProps?.children || [];
  // Bailout: props(除 children) 浅相等 且 children 引用相等（或都是空） -> 直接克隆子树
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

// 辅助：将 VNode 的 children 注入 props，便于 HostComponent 在 updateHostComponent 中读取
function wrapProps(vnode: any) {
  if (!vnode) return {};
  const ch = vnode.children && vnode.children.length ? vnode.children : null;
  if (!ch) return vnode.props || {};
  return { ...(vnode.props || {}), children: vnode.children };
}
function reconcileChildren(returnFiber: FiberNode, children: any[]) {
  if (!children) children = [];
  if (!Array.isArray(children)) children = [children];

  // 判定是否进入 keyed 模式（全部对象子节点并至少一个 key 不为 null）
  const keyable = children.length > 0 && children.every(c => typeof c !== 'string' && typeof c !== 'number') && children.some(c => c && c.key != null);

  let oldFiber = returnFiber.alternate?.child || null;

  if (keyable) {
    const oldKeyMap = new Map<any, FiberNode>();
    let of = oldFiber;
    let oldIndexCounter = 0;
    while (of) { if (of.key != null) { (of as any)._oldIndex = oldIndexCounter; oldKeyMap.set(of.key, of); } of = of.sibling; oldIndexCounter++; }

    let prevNewFiber: FiberNode | null = null;
    const used = new Set<any>();
    let lastPlacedIndex = -1; // 用于最小化移动：记录当前保持顺序的最大 oldIndex

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child == null) continue;
      let newFiber: FiberNode | null = null;
      if (typeof child === 'string' || typeof child === 'number') {
        newFiber = createFiber(FiberTag.Text, String(child), null);
        newFiber.flags |= Flags.Placement; // 文本直接新建
      } else {
        const matched = child.key != null ? oldKeyMap.get(child.key) : null;
        if (matched && matched.type === child.type) {
          const newPending = wrapProps(child);
            newFiber = createWorkInProgress(matched, newPending);
            newFiber.type = child.type;
            if (!shallowEqual(matched.memoizedProps, newPending)) newFiber.flags |= Flags.Update;
            // 移动检测：oldIndex < lastPlacedIndex 说明需要重新插入
            const oldIdx = (matched as any)._oldIndex ?? 0;
            if (oldIdx < lastPlacedIndex) {
              newFiber.flags |= Flags.Placement; // 标记需要移动
            } else {
              lastPlacedIndex = oldIdx;
            }
            used.add(child.key);
        } else {
          const wProps = wrapProps(child);
          newFiber = createFiber(typeof child.type === 'function' ? FiberTag.FunctionComponent : FiberTag.HostComponent, wProps, child.key);
          newFiber.type = child.type;
          newFiber.flags |= Flags.Placement;
        }
      }
      newFiber.return = returnFiber;
      if (!prevNewFiber) returnFiber.child = newFiber; else prevNewFiber.sibling = newFiber;
      prevNewFiber = newFiber;
    }
    oldKeyMap.forEach((f, k) => { if (!used.has(k)) { f.flags |= Flags.Deletion; pushEffect(f); } });
    return;
  }

  // 线性（非 keyed）
  let prevNew: FiberNode | null = null;
  let old = oldFiber;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child == null) continue;
    let newFiber: FiberNode | null = null;

    if (typeof child === 'string' || typeof child === 'number') {
      if (old && old.tag === FiberTag.Text) {
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
        newFiber = createFiber(typeof child.type === 'function' ? FiberTag.FunctionComponent : FiberTag.HostComponent, wProps, child.key);
        newFiber.type = child.type;
        newFiber.flags |= Flags.Placement;
      }
    }
    if (old) old = old.sibling;
    newFiber.return = returnFiber;
    if (!prevNew) returnFiber.child = newFiber; else prevNew.sibling = newFiber;
    prevNew = newFiber;
  }
  // 多余旧 fiber 删除
  while (old) { old.flags |= Flags.Deletion; pushEffect(old); old = old.sibling; }
}

function completeWork(fiber: FiberNode) {
  switch (fiber.tag) {
    case FiberTag.HostComponent:
      if (!fiber.stateNode) {
        const el = document.createElement(fiber.type);
        fiber.stateNode = el;
        // 初次挂载：设置初始 props (含事件)
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
  }
  if (fiber.flags & (Flags.Placement | Flags.Update | Flags.Deletion)) pushEffect(fiber);
}

function bubbleEffects(fiber: FiberNode) {
  let subtree = Flags.NoFlags;
  let child = fiber.child;
  while (child) {
    subtree |= child.subtreeFlags | child.flags;
    child = child.sibling;
  }
  fiber.subtreeFlags = subtree;
}

function pushEffect(fiber: FiberNode) {
  if (!root) return;
  if (!root.firstEffect) root.firstEffect = fiber; else (root.lastEffect as FiberNode).effectNext = fiber;
  root.lastEffect = fiber;
}

// 收集需执行的 passive effect 的函数组件 fiber
const pendingLayoutEffects: FiberNode[] = [];
const pendingPassiveEffects: FiberNode[] = [];
let passiveFlushScheduled = false; // 修复缺失声明 & 防抖标记
let passiveFlushId = 0;            // 递增 flush id 方便调试批次
function pushEffectFiber(fiber: FiberNode){
  // 避免重复加入
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
function flushPassiveEffects(){
  if (!pendingPassiveEffects.length) { passiveFlushScheduled = false; return; }
  const batchId = ++passiveFlushId;
  const start = performance.now();
  let fibers=0, destroyCount=0, createCount=0;
  if (debugConfig.effect.logPassive) debugLog('passive phase (destroy)', { batch:batchId, pending:persistentPassiveCountSnapshot() });
  // destroy 阶段
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
  // create 阶段
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
// 统计当前待执行 passive effect 的 effect 数量（调试）
function persistentPassiveCountSnapshot(){
  let count=0; for (const f of pendingPassiveEffects){ if(!f.hooks) continue; for (const h of f.hooks) if(h && h.__type==='effect' && h.kind==='passive' && (h.firstRun || h.depsChanged)) count++; }
  return count;
}
// cleanup 顺序策略：parent-first (当前默认) / child-first (post-order)
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

function commitRoot(finished: FiberNode | null) {
  if (!root) return;
  let effect = root.firstEffect;
  while (effect) {
    commitEffect(effect);
    effect = effect.effectNext;
  }
  if (finished) root.current = finished;
  root.firstEffect = root.lastEffect = null;
  try { flushLayoutEffects(); } catch(e){ console.error('flushLayoutEffects error', e); }
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

function commitEffect(fiber: FiberNode) {
  if (fiber.flags & Flags.Placement) commitPlacement(fiber);
  if (fiber.flags & Flags.Update) commitUpdate(fiber);
  if (fiber.flags & Flags.Deletion) commitDeletion(fiber);
}

function findHostParent(fiber: FiberNode): HTMLElement | null {
  let parent = fiber.return;
  while (parent) {
    if (parent.tag === FiberTag.HostComponent) return parent.stateNode;
    if (parent.tag === FiberTag.HostRoot) return parent.stateNode;
    parent = parent.return;
  }
  return null;
}

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

function commitUpdate(fiber: FiberNode) {
  if (fiber.tag === FiberTag.HostComponent) {
    const dom = fiber.stateNode as HTMLElement;
    updateHostComponentProps(dom, fiber.alternate?.memoizedProps || {}, fiber.pendingProps || {});
    fiber.memoizedProps = fiber.pendingProps;
  }
  // Text 已在 completeWork 中直接更新
}

function commitDeletion(fiber: FiberNode) {
  // 先执行 effect cleanup
  cleanupPassiveEffects(fiber);
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

// props diff（简化版）：事件 onX、普通属性，忽略 children / key
function updateHostComponentProps(el: HTMLElement, oldProps: any, newProps: any) {
  // 移除旧
  for (const key in oldProps) {
    if (key === 'children' || key === 'key') continue;
    if (!(key in newProps)) {
      if (/^on[A-Z]/.test(key)) {
        const evt = key.slice(2).toLowerCase();
        el.removeEventListener(evt, oldProps[key]);
      } else {
        (el as any)[key] !== undefined ? (el as any)[key] = '' : el.removeAttribute(key);
      }
    }
  }
  // 添加/更新
  for (const key in newProps) {
    if (key === 'children' || key === 'key') continue;
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

// ===== Phase5: 可中断 / 恢复 渲染 (Concurrent-like) =====
// 基于 lanes 选择：UserBlocking / High -> 同步；Normal/Low/Idle -> 并发时间分片
// 简化：新高优任务到来直接重新自根开始，丢弃中间 WIP。

let isRenderingConcurrent = false;
let currentWipRoot: FiberNode | null = null;
const FRAME_BUDGET = 5; // ms 预算

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
  return lane === (1<<0) || lane === (1<<1); // user-blocking / high 同步
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
    // 仍有剩余，继续调度下一帧
    requestConcurrentCallback();
  }
}
// 并发实现内部函数
function renderRootConcurrentInternal(vnode: VNode, container: HTMLElement) {
  if (!root) {
    const hostRoot = createFiber(FiberTag.HostRoot, vnode, null);
    hostRoot.stateNode = container;
    root = { container, current: hostRoot, finishedWork: null, firstEffect: null, lastEffect: null };
  }
  rootElement = vnode;
  const activeLanes = pendingLanes || (1<<2); // 若无 lane 默认 normal
  const highest = getHighestPriorityLane(activeLanes);
  pendingLanes = Lanes.NoLanes; // 已消费
  workInProgress = createWorkInProgress(root.current, wrapProps(vnode));
  currentWipRoot = workInProgress;
  if (isSyncLane(highest)) {
    workLoopSync();
    commitRoot(currentWipRoot);
  } else {
    startConcurrentWorkLoop();
  }
}
// 对外：调度根更新（供 hooks 内 componentInstance.update 调用）
export function scheduleRootUpdate(lane?: number) {
  // 新增：调试输出批量合并前的 pendingPassive 数量（若启用）
  if (debugConfig.schedule.log) debugLog('scheduleRootUpdate', { lane, pendingLanesBefore: pendingLanes });
  if (lane != null) pendingLanes = mergeLanes(pendingLanes, lane);
  if (isRenderingConcurrent) {
    const highestIncoming = getHighestPriorityLane(pendingLanes);
    if (isSyncLane(highestIncoming)) {
      workInProgress = null; // 放弃
      isRenderingConcurrent = false;
    }
  }
  if (root && rootElement) {
    try { renderRoot(rootElement, root.container); } catch(e){ console.error(e); }
  } else {
    // 初次
    if (rootElement && (rootElement as any).type && typeof document !== 'undefined') {
      // 需要调用渲染时 root=null，将在内部创建
      const containerEl = (root as any)?.container || document.getElementById('root');
      if (containerEl) renderRoot(rootElement, containerEl as any);
    }
  }
}
// ===== End Phase5 additions =====
