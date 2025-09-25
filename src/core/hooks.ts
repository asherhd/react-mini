// hooks.ts
// Phase3(部分): hooks 与 Fiber 融合
// - useState / useEffect 状态挂载在当前渲染的 Fiber.hooks 数组
// - useEffect 记录 effect 对象 { __type:'effect', create, deps, destroy, firstRun, depsChanged }
// - 不在渲染阶段执行副作用；提交后由 fiber.ts 的 flushPassiveEffects 统一处理
// - 仍保留旧的 currentComponent 以兼容 legacy diff 渲染路径
// ------------------------------------------------------------------
import { scheduleRootUpdate } from './fiber';

// legacy 兼容：函数组件实例（旧 diff 使用）
let currentComponent: any = null; // 保留导出
let hookIndex = 0;

// Fiber 当前渲染的 FunctionComponent Fiber
let currentFiber: any = null;

export function prepareToUseHooks(fiber: any) {
  currentFiber = fiber;
  hookIndex = 0;
  fiber.hooks = fiber.hooks || [];
}
export function finishHooks() {
  currentFiber = null;
  currentComponent = null;
}

// 旧 diff 入口仍可调用
export function setCurrentComponent(instance: any) {
  currentComponent = instance;
  hookIndex = 0;
  currentComponent.hooks = currentComponent.hooks || [];
}
export function resetCurrentComponent() {
  currentComponent = null;
}
export { currentComponent, hookIndex, currentFiber };

// 统一获取当前 hooks 容器（优先 Fiber）
function getHooksArray() {
  if (currentFiber) return currentFiber.hooks;
  if (currentComponent) return currentComponent.hooks;
  throw new Error('hooks: no current fiber/component');
}

// Lane 优先级映射（与 fiber.ts 保持一致，若未加载 fiber.ts 仍可安全降级）
const LaneMap: Record<string, number> = {
  'user-blocking': 1 << 0,
  'high': 1 << 1,
  'normal': 1 << 2,
  'low': 1 << 3,
  'idle': 1 << 4
};

export function useState(initialValue: any) {
  const hooksArr = getHooksArray();
  const idx = hookIndex;
  if (hooksArr[idx] === undefined) {
    hooksArr[idx] = { __type: 'state', value: typeof initialValue === 'function' ? initialValue() : initialValue };
  }
  const setState = (newValue: any, priority: 'user-blocking' | 'high' | 'normal' | 'low' | 'idle' = 'normal') => {
    const prev = hooksArr[idx].value;
    const next = typeof newValue === 'function' ? newValue(prev) : newValue;
    hooksArr[idx].value = next;
    // 通过 lane 通知调度（当前实现仍同步兜底）
    const lane = LaneMap[priority] ?? LaneMap['normal'];
    scheduleRootUpdate(lane);
  };
  hookIndex++;
  return [hooksArr[idx].value, setState];
}

interface EffectHook {
  __type: 'effect';
  kind: 'passive' | 'layout';
  create: Function;
  deps?: any[];
  destroy: Function | null;
  firstRun: boolean;
  depsChanged: boolean;
}

export function useEffect(create: Function, deps?: any[]) {
  const hooksArr = getHooksArray();
  const idx = hookIndex++;
  const isFirst = hooksArr[idx] === undefined;
  if (isFirst) {
    const eff: EffectHook = { __type: 'effect', kind: 'passive', create, deps, destroy: null, firstRun: true, depsChanged: true };
    hooksArr[idx] = eff;
    return;
  }
  const eff = hooksArr[idx] as EffectHook;
  eff.create = create;
  if (!deps) { eff.depsChanged = true; }
  else if (!eff.deps) { eff.depsChanged = true; }
  else if (deps.length !== eff.deps.length) { eff.depsChanged = true; }
  else { eff.depsChanged = deps.some((d,i)=> d!==eff.deps![i]); }
  eff.deps = deps;
}

export function useLayoutEffect(create: Function, deps?: any[]) {
  const hooksArr = getHooksArray();
  const idx = hookIndex++;
  const isFirst = hooksArr[idx] === undefined;
  if (isFirst) {
    const eff: EffectHook = { __type: 'effect', kind: 'layout', create, deps, destroy: null, firstRun: true, depsChanged: true };
    hooksArr[idx] = eff;
    return;
  }
  const eff = hooksArr[idx] as EffectHook;
  eff.create = create;
  if (!deps) { eff.depsChanged = true; }
  else if (!eff.deps) { eff.depsChanged = true; }
  else if (deps.length !== eff.deps.length) { eff.depsChanged = true; }
  else { eff.depsChanged = deps.some((d,i)=> d!==eff.deps![i]); }
  eff.deps = deps;
}

export function useRef<T = any>(initialValue: T): { current: T } {
  const hooksArr = getHooksArray();
  const idx = hookIndex;
  if (hooksArr[idx] === undefined) {
    hooksArr[idx] = { __type: 'ref', current: initialValue };
  }
  hookIndex++;
  return hooksArr[idx];
}

export function useMemo<T>(factory: () => T, deps: any[]): T {
  const hooksArr = getHooksArray();
  const idx = hookIndex;
  if (hooksArr[idx] === undefined) {
    hooksArr[idx] = { __type: 'memo', value: factory(), deps };
    hookIndex++;
    return hooksArr[idx].value;
  }
  const memo = hooksArr[idx];
  let changed = !deps || !memo.deps || deps.length !== memo.deps.length || deps.some((d: any, i: number) => d !== memo.deps[i]);
  if (changed) {
    memo.value = factory();
    memo.deps = deps;
  }
  hookIndex++;
  return memo.value;
}

export function useCallback<T extends (...args: any[]) => any>(cb: T, deps: any[]): T {
  // 基于 useMemo
  return useMemo(() => cb, deps);
}

// （说明）
// 副作用执行策略：
// 1. 初次挂载：firstRun=true -> 提交后执行 create()，返回值保存为 destroy。
// 2. 依赖变化：depsChanged=true -> 提交后先执行上一次 destroy()，再 create()。
// 3. 依赖未变：跳过。
// 4. 卸载：在 commitDeletion 中统一执行 destroy()。
//
// 副作用执行策略（扩展）：
// passive(useEffect) 延后到微任务；layout(useLayoutEffect) 在 DOM 变更后同步执行。
