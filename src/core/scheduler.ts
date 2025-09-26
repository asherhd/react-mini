// scheduler.ts
// =====================================================================
// 简化版调度器 (独立于 Fiber 的演示层)：
// - 多优先级任务队列 (user-blocking > high > normal > low > idle)
// - 时间分片：高优不受限；normal/low 受帧预算；idle 仅在富余时间
// - 批量回调：所有任务清空后统一触发提交回调
// - 去重 / 优先级提升：同一组件多次调度会合并，且可升级优先级
// - 与 Fiber lanes 概念平行存在（当前架构中 Fiber 主路径使用 scheduleRootUpdate）
// =====================================================================

export type Priority = 'user-blocking' | 'high' | 'normal' | 'low' | 'idle';
const PriorityOrder: Priority[] = ['user-blocking','high','normal','low','idle'];
const PriorityIndex: Record<Priority, number> = {
  'user-blocking':0,
  'high':1,
  'normal':2,
  'low':3,
  'idle':4
};

interface Work { type:'component'; component:any; priority:Priority; }

// 队列：按优先级顺序存放 Set（Set 保证去重 + 快速删除）
const queues: Array<Set<Work>> = PriorityOrder.map(()=>new Set());
// 组件到 work 的映射，便于升级优先级 / 去重
const componentMap = new WeakMap<any, Work>();

let isFlushing = false;   // 是否正在 flush（防止重入）
let scheduled = false;    // 是否已经请求 host 回调
const FRAME_BUDGET = 6;   // 时间片预算 (ms)
let cycleId = 0;          // 统计批次 id
let latestStats: any = null; // 最近一次 flush 统计结果
const commitCallbacks: Set<(stats:any)=>void> = new Set(); // 任务全部完成后执行

function now(){ return performance.now(); }

// 注册在“所有当前任务完成”之后触发的回调（类似批提交）
export function scheduleCommitCallback(fn:(stats:any)=>void){ commitCallbacks.add(fn); }
export function getSchedulerStats(){ return latestStats; }

function requestFlush(){ if (!scheduled){ scheduled = true; requestHostCallback(); } }

// host 回调：优先使用 requestIdleCallback；降级 setTimeout
function requestHostCallback(){
  if (typeof (window as any).requestIdleCallback === 'function') {
    (window as any).requestIdleCallback(flush);
  } else {
    setTimeout(()=>flush({ timeRemaining: ()=>0, didTimeout:true }),1);
  }
}

// 执行具体组件更新逻辑（这里假设组件实例上有 update 方法）
function runComponent(instance:any){
  try { instance.update(); } catch(e){ console.error('update error', e); }
}

function createStats(){
  return { id:++cycleId, start: now(), end:0, processed:{'user-blocking':0,'high':0,'normal':0,'low':0,'idle':0} };
}

function hasPending(){ return queues.some(q=>q.size>0); }

// 核心 flush：按优先级从高到低执行，应用时间片限制
function flush(deadline:any){
  if (isFlushing) return;
  isFlushing = true; scheduled = false;
  const stats = createStats();
  const frameEnd = now() + FRAME_BUDGET;

  // 处理单个优先级队列
  const processQueue = (idx:number, timeLimited:boolean) => {
    const set = queues[idx];
    const limitIdle = PriorityOrder[idx] === 'idle'; // idle 限制更严格
    while (set.size){
      if (timeLimited && (deadline.timeRemaining?.()<=0 && now()>frameEnd)) break; // normal/low 时间片耗尽 -> 让出
      if (limitIdle && (deadline.timeRemaining?.()<=0 || now()>frameEnd)) break;   // idle 需“富余”
      const work = set.values().next().value as Work;
      set.delete(work);
      runComponent(work.component);
      stats.processed[work.priority]++;
    }
  };

  // user-blocking / high: 不受时间片限制
  processQueue(0,false);
  processQueue(1,false);
  // normal / low: 时间片约束
  processQueue(2,true);
  processQueue(3,true);
  // idle: 仅在空闲富余时执行
  processQueue(4,true);

  stats.end = now();
  latestStats = stats;
  isFlushing = false;

  if (hasPending()) {
    // 还有任务 -> 下一帧继续
    requestFlush();
  } else {
    // 所有任务完成 -> 执行提交回调并清空
    if (commitCallbacks.size){
      commitCallbacks.forEach(cb=>{ try{ cb(stats); }catch(e){ console.error(e); } });
      commitCallbacks.clear();
    }
  }
}

// 优先级提升：更高优先级值（索引更小）会将 work 从旧队列移到新队列
function upgradePriority(work:Work, newP:Priority){
  if (PriorityIndex[newP] < PriorityIndex[work.priority]) {
    const oldSet = queues[PriorityIndex[work.priority]];
    oldSet.delete(work);
    work.priority = newP;
    queues[PriorityIndex[newP]].add(work);
  }
}

// 外部 API：调度组件更新
export function scheduleUpdate(component:any, priority:Priority | 'high' | 'normal' = 'normal') {
  const p:Priority = (priority === 'high' || priority === 'normal' || priority === 'low' || priority === 'idle' || priority === 'user-blocking') ? priority as Priority : 'normal';
  let work = componentMap.get(component);
  if (!work){
    work = { type:'component', component, priority:p };
    componentMap.set(component, work);
    queues[PriorityIndex[p]].add(work);
  } else {
    if (PriorityIndex[p] < PriorityIndex[work.priority]) {
      upgradePriority(work, p);
    } else {
      const set = queues[PriorityIndex[work.priority]];
      if (!set.has(work)) set.add(work); // 再次加入以确保被处理
    }
  }
  // 立即响应：高优 / normal 通过微任务尽快 flush；低优仍走 idleCallback
  if (p === 'user-blocking' || p === 'high' || p === 'normal') {
    Promise.resolve().then(()=>{ if (!isFlushing) flush({ timeRemaining: ()=>1, didTimeout:false }); });
  } else {
    requestFlush();
  }
}
