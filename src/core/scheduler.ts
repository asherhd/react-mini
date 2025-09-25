// scheduler.ts
// Fiber 风格调度（演示用）：多优先级 + 时间分片 + 提交阶段统计
// Priorities: user-blocking > high > normal > low > idle
// API:
//   scheduleUpdate(component, priority?)
//   scheduleCommitCallback(fn)
//   getSchedulerStats()
// 目标：
//   A. 更多优先级层级
//   B. 批量 flush 提交回调 + 统计
//   C. 模拟 fiber 可中断：低优先级在时间片用尽后让出主线程

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

// 使用数组存 Set，按优先级序排
const queues: Array<Set<Work>> = PriorityOrder.map(()=>new Set());
// 组件 -> work 映射，用于去重 / 升级优先级
const componentMap = new WeakMap<any, Work>();

let isFlushing = false;
let scheduled = false;
const FRAME_BUDGET = 6; // ms 时间片
let cycleId = 0;
let latestStats: any = null;
const commitCallbacks: Set<(stats:any)=>void> = new Set();

function now(){ return performance.now(); }

export function scheduleCommitCallback(fn:(stats:any)=>void){ commitCallbacks.add(fn); }
export function getSchedulerStats(){ return latestStats; }

function requestFlush(){ if (!scheduled){ scheduled = true; requestHostCallback(); } }

function requestHostCallback(){
  if (typeof (window as any).requestIdleCallback === 'function') {
    (window as any).requestIdleCallback(flush);
  } else {
    setTimeout(()=>flush({ timeRemaining: ()=>0, didTimeout:true }),1);
  }
}

function runComponent(instance:any){
  try { instance.update(); } catch(e){ console.error('update error', e); }
}

function createStats(){
  return { id:++cycleId, start: now(), end:0, processed:{'user-blocking':0,'high':0,'normal':0,'low':0,'idle':0} };
}

function hasPending(){ return queues.some(q=>q.size>0); }

function flush(deadline:any){
  if (isFlushing) return;
  isFlushing = true; scheduled = false;
  const stats = createStats();
  const frameEnd = now() + FRAME_BUDGET;
  // 逐优先级处理；高两级不受时间片限制，normal/low 受限制，idle 仅在空闲充足时执行
  const processQueue = (idx:number, timeLimited:boolean) => {
    const set = queues[idx];
    const limitIdle = PriorityOrder[idx] === 'idle';
    while (set.size){
      if (timeLimited && (deadline.timeRemaining?.()<=0 && now()>frameEnd)) break; // 让出
      if (limitIdle && (deadline.timeRemaining?.()<=0 || now()>frameEnd)) break; // idle 仅在富余时间
      const work = set.values().next().value as Work;
      set.delete(work);
      runComponent(work.component);
      stats.processed[work.priority]++;
    }
  };

  // user-blocking & high: 不限
  processQueue(0,false); // user-blocking
  processQueue(1,false); // high
  // normal / low: 时间片
  processQueue(2,true);
  processQueue(3,true);
  // idle: 仅富余
  processQueue(4,true);

  stats.end = now();
  latestStats = stats;

  isFlushing = false;

  if (hasPending()) {
    // 仍有任务，继续调度下一帧
    requestFlush();
  } else {
    // 提交阶段：执行回调
    if (commitCallbacks.size){
      commitCallbacks.forEach(cb=>{ try{ cb(stats); }catch(e){ console.error(e); } });
      commitCallbacks.clear();
    }
  }
}

function upgradePriority(work:Work, newP:Priority){
  if (PriorityIndex[newP] < PriorityIndex[work.priority]) {
    // 从旧队列移出，放入新优先级队列
    const oldSet = queues[PriorityIndex[work.priority]];
    oldSet.delete(work);
    work.priority = newP;
    queues[PriorityIndex[newP]].add(work);
  }
}

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
      if (!set.has(work)) set.add(work);
    }
  }
  // 调整：normal/high 也使用微任务立即 flush，避免等待空闲导致第一次点击无反馈
  if (p === 'user-blocking' || p === 'high' || p === 'normal') {
    Promise.resolve().then(()=>{ if (!isFlushing) flush({ timeRemaining: ()=>1, didTimeout:false }); });
  } else {
    requestFlush();
  }
}
