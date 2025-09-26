// createElement.ts
// 构建虚拟 DOM（VNode） + JSX 工厂
// 支持 <div /> 与 <Component /> 以及 Fragment (<></>)
import type { VNode } from './types';

export const Fragment = Symbol('Fragment');

export function createElement(type: any, props: Record<string, any> | null = {}, ...childArgs: any[]): VNode {
  // 兼容 JSX classic transform 会传入 null 作为 props
  let normalizedProps: Record<string, any> = props == null ? {} : props;
  // 收集 children：优先使用参数，其次 props.children
  let collected: any[] = [];
  if (childArgs.length) collected = childArgs.flat();
  else if (normalizedProps.children != null) collected = Array.isArray(normalizedProps.children) ? normalizedProps.children : [normalizedProps.children];
  // 统一存储 children，并在 props 中也保留（方便用户读取 props.children）
  if (collected.length) {
    // 避免直接修改外部传入对象（可能被冻结）
    normalizedProps = { ...normalizedProps, children: collected };
  } else {
    collected = [];
    // 确保 props.children 不为 undefined（可选）这里保持不加，避免多余字段
  }
  return {
    type,
    props: normalizedProps,
    children: collected,
    key: normalizedProps.key,
    dom: null,
  };
}
