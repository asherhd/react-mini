// 全局 JSX 类型声明：允许在 .tsx 中直接使用任意标签名
// 简化：所有 IntrinsicElements 属性为 any，后续可细化 HTMLAttributes 类型
import type { VNode } from './core/types';

interface MiniHTMLAttributes {
  key?: any;
  children?: any;
  style?: Record<string, any> | string;
  onClick?: (e: any) => void;
  onInput?: (e: any) => void;
  [k: string]: any;
}

declare global {
  namespace JSX {
    // 组件返回类型
    interface Element extends VNode {}
    // createElement 返回值
    interface ElementClass {}
    interface ElementAttributesProperty { props: {}; }
    interface ElementChildrenAttribute { children: 'children'; }
    interface IntrinsicElements {
      div: MiniHTMLAttributes;
      h1: MiniHTMLAttributes;
      h2: MiniHTMLAttributes;
      button: MiniHTMLAttributes;
      input: MiniHTMLAttributes;
      ul: MiniHTMLAttributes;
      li: MiniHTMLAttributes;
      strong: MiniHTMLAttributes;
      ol: MiniHTMLAttributes;
      span: MiniHTMLAttributes;
      [elem: string]: any; // 兜底
    }
  }
}

export {}; // 确保这是一个模块，避免与全局作用域冲突
