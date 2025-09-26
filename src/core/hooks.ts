// hooks.ts
// ---------------------------------------------------------------
// Mini React Hooks 系统（与 Fiber 融合版）
// 设计目标：
// - 与当前正在渲染的 FunctionComponent 对应的 Fiber 绑定（fiber.hooks 数组）
// - 渲染阶段仅收集数据，不执行副作用（effect 延迟到 commit 阶段）
// - 支持 useState / useRef / useMemo / useCallback / useEffect / useLayoutEffect
// - 与旧的 legacy diff（非 Fiber）路径兼容：保留 currentComponent 方式
// - 简化实现：不做并发 render 中间状态隔离，不做 Hook 链表，仅用数组 + 索引
//
// 与 React 差异：
// - 没有 Hook 调用顺序错误检测（React 通过当前 dispatcher + 链表结构校验）
// - 没有支持 useReducer / useImperativeHandle / useTransition 等扩展 Hook
// - 没有真正的 Hook lane 分离；只是在 setState 时传入一个 lane（优先级位）
// - 没有 effect 挂载/更新阶段的双阶段区分（本实现依赖 fiber.ts 的 commit 分阶段）
// - 不支持 render 中途打断后恢复时的 Hook 状态回退（实验中的并发仍简单覆盖）
// ---------------------------------------------------------------

import { scheduleRootUpdate } from './fiber';

// ===================================================================
// 1. 类型定义
// ===================================================================

// EffectHook 用于 useEffect / useLayoutEffect，两者仅差异在 kind
interface EffectHook {
  __type: 'effect';              // 标识此 hook 类型
  kind: 'passive' | 'layout';     // passive = useEffect（异步/延后），layout = useLayoutEffect（同步）
  create: Function;               // 副作用工厂函数，返回清理函数或 undefined
  deps?: any[];                   // 依赖数组（可选）
  destroy: Function | null;       // 上一次副作用返回的清理函数
  firstRun: boolean;              // 是否首次执行（首次一定会执行 effect）
  depsChanged: boolean;           // 依赖本轮是否变化（commit 阶段决定是否重新执行）
}

// ===================================================================
// 2. 调度 / 优先级映射
// ===================================================================
// LaneMap：与 fiber.ts 的 lanes 设计对齐，setState 时通过 lane 触发不同优先级调度。
// 此处只维护一个常量映射，真正的优先级合并/调度在 fiber / scheduler 内部完成。
const LaneMap: Record<string, number> = {
  'user-blocking': 1 << 0,
  'high':          1 << 1,
  'normal':        1 << 2,
  'low':           1 << 3,
  'idle':          1 << 4
};

// ===================================================================
// 3. 当前渲染上下文（Fiber 优先，兼容 legacy component）
// ===================================================================
// Fiber 模式：currentFiber 指向正在渲染的函数组件 Fiber，hooks 结果存放在 fiber.hooks 数组。
// 旧 diff 模式：currentComponent（组件实例）仍可被设置，并在其上挂载 hooks 数组。

let currentFiber: any = null;   // 当前渲染的 FunctionComponent 对应的 Fiber（Fiber 路径）
let currentComponent: any = null; // 旧 diff 路径使用的组件实例（legacy 兼容）
let hookIndex = 0;              // 当前组件渲染时的 hook 游标（严格依赖调用顺序）

// 导出便于调试 / 其他模块（若需要）引用
export { currentComponent, hookIndex, currentFiber };

// ===================================================================
// 4. 渲染前后准备（供 Fiber 渲染流程调用）
// ===================================================================

// 在 beginWork 对函数组件执行时调用：准备 hook 环境
export function prepareToUseHooks(fiber: any) {
  currentFiber = fiber;
  hookIndex = 0;
  // 初始化 hooks 容器（数组），每个下标对应一次 Hook 调用的状态
  fiber.hooks = fiber.hooks || [];
}

// 函数组件完成一次 render（无论成功或出错回退）后清理上下文
export function finishHooks() {
  currentFiber = null;
  currentComponent = null; // legacy 也同步清理，避免串用
}

// ===================================================================
// 5. 兼容旧 diff 渲染路径的接口
// ===================================================================

export function setCurrentComponent(instance: any) {
  currentComponent = instance;
  hookIndex = 0;
  currentComponent.hooks = currentComponent.hooks || [];
}
export function resetCurrentComponent() {
  currentComponent = null;
}

// ===================================================================
// 6. 内部工具方法
// ===================================================================

// 统一获取当前 hooks 存储数组（优先 Fiber）。若都没有，说明 hook 在非法上下文被调用。
function getHooksArray() {
  if (currentFiber) return currentFiber.hooks;
  if (currentComponent) return currentComponent.hooks;
  throw new Error('hooks: no current fiber/component (Hook 调用不在函数组件渲染上下文中)');
}

// ===================================================================
// 7. 各类 Hook 实现
// ===================================================================
// 说明：全部基于数组 + 索引。hookIndex 在组件 render 期间自增。
// useState / useRef / useMemo / useCallback / useEffect / useLayoutEffect

// ----------------------------- useState --------------------------------
// 存储结构：{ __type:'state', value }
// setState：更新 value，并根据传入优先级 lane 调度根更新（当前实现始终触发根调度）
export function useState(initialValue: any) {
  const hooksArr = getHooksArray();
  const idx = hookIndex;

  // 首次创建：支持懒初始化（初始值为函数时调用得到真实值）
  if (hooksArr[idx] === undefined) {
    hooksArr[idx] = {
      __type: 'state',
      value: typeof initialValue === 'function' ? initialValue() : initialValue
    };
  }

  const setState = (
    newValue: any,
    priority: 'user-blocking' | 'high' | 'normal' | 'low' | 'idle' = 'normal'
  ) => {
    const prev = hooksArr[idx].value;
    const next = typeof newValue === 'function' ? newValue(prev) : newValue;
    if (Object.is(prev, next)) return; // 值未变化可直接跳过（简单优化）
    hooksArr[idx].value = next;
    const lane = LaneMap[priority] ?? LaneMap['normal'];
    // 触发根更新（fiber.ts 内部依据 lane 决定同步 / 并发 & 是否打断其他渲染）
    scheduleRootUpdate(lane);
  };

  hookIndex++;
  return [hooksArr[idx].value, setState] as const;
}

// ----------------------------- useRef ----------------------------------
// 返回一个稳定对象 { current }，跨 render 持久。
export function useRef<T = any>(initialValue: T): { current: T } {
  const hooksArr = getHooksArray();
  const idx = hookIndex;
  if (hooksArr[idx] === undefined) {
    hooksArr[idx] = { __type: 'ref', current: initialValue };
  }
  hookIndex++;
  return hooksArr[idx];
}

// ----------------------------- useMemo ---------------------------------
// 依赖未变则复用缓存值；依赖变化重新执行 factory。
// 存储结构：{ __type:'memo', value, deps }
export function useMemo<T>(factory: () => T, deps: any[]): T {
  const hooksArr = getHooksArray();
  const idx = hookIndex;

  if (hooksArr[idx] === undefined) {
    hooksArr[idx] = { __type: 'memo', value: factory(), deps };
    hookIndex++;
    return hooksArr[idx].value;
  }

  const memo = hooksArr[idx];
  const changed = !deps || !memo.deps || deps.length !== memo.deps.length || deps.some((d: any, i: number) => d !== memo.deps[i]);
  if (changed) {
    memo.value = factory();
    memo.deps = deps;
  }
  hookIndex++;
  return memo.value;
}

// ----------------------------- useCallback -----------------------------
// 等价于 useMemo(() => fn, deps)
export function useCallback<T extends (...args: any[]) => any>(cb: T, deps: any[]): T {
  return useMemo(() => cb, deps);
}

// ----------------------------- useEffect / useLayoutEffect -------------
// 两者共享 EffectHook 结构：
// - layout: 在 commit DOM 更新后同步执行（提升视觉一致性，类似 React useLayoutEffect）
// - passive: 延后到异步阶段批量执行（帧后或宏/微任务中），避免阻塞渲染
// 标记逻辑：
//   firstRun=true  => 必执行
//   depsChanged    => 执行并在执行前若有 destroy 先清理
//   deps 未变      => 跳过
// 卸载：在 Fiber commit 删除阶段统一执行 destroy

function mountOrUpdateEffect(kind: 'passive' | 'layout', create: Function, deps?: any[]) {
  const hooksArr = getHooksArray();
  const idx = hookIndex++;
  const isFirst = hooksArr[idx] === undefined;

  if (isFirst) {
    const eff: EffectHook = {
      __type: 'effect',
      kind,
      create,
      deps,
      destroy: null,
      firstRun: true,
      depsChanged: true // 首次一定视为变化
    };
    hooksArr[idx] = eff;
    return;
  }

  const eff = hooksArr[idx] as EffectHook;
  eff.create = create; // 更新最新的副作用函数

  // 依赖比对：
  if (!deps) { // 无依赖：每次都视为变化（与 React 行为对齐）
    eff.depsChanged = true;
  } else if (!eff.deps) {
    eff.depsChanged = true; // 之前无依赖，本次有依赖 => 变化
  } else if (deps.length !== eff.deps.length) {
    eff.depsChanged = true; // 长度不同 => 变化
  } else {
    eff.depsChanged = deps.some((d, i) => d !== eff.deps![i]); // 任一元素不同 => 变化
  }
  eff.deps = deps;
}

export function useEffect(create: Function, deps?: any[]) {
  mountOrUpdateEffect('passive', create, deps);
}

export function useLayoutEffect(create: Function, deps?: any[]) {
  mountOrUpdateEffect('layout', create, deps);
}

// ===================================================================
// 8. 说明（副作用执行时机摘要）
// ===================================================================
// 提交阶段（见 fiber.ts）：
// 1. layout effects：commit DOM 变更后立即同步执行。
// 2. passive effects：延后（微/宏任务）批量执行；执行顺序固定：先 destroy 再 create。
// 3. 删除节点：在 commitDeletion 时统一执行对应 hook 的 destroy（若存在）。
//
// 依赖变化判断策略与 React 一致：
// - 未提供 deps => 每次渲染视为变化
// - 初次 => firstRun=true => 一定执行
// - 提供 deps 且长度 / 任一项不同 => depsChanged=true
// - 否则跳过
// ===================================================================

// （保留文件末尾空行，便于追加新 Hook）
