// TodoApp.tsx (JSX 版)
import { createElement, useState } from '../core';

function TodoList() {
  const [list, setList] = useState(['A', 'B', 'C']);
  return (
    <div>
      <ul>
        {list.map((item: string) => <li key={item}>{item}</li>)}
      </ul>
      <button onClick={() => setList((prev:any) => prev.slice().reverse())}>变更顺序</button>
    </div>
  );
}

export function TodoApp() {
  return (
    <div>
      <TodoList />
    </div>
  );
}
