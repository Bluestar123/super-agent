import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import Button from './Button.tsx';

function App() {
  const [todos, setTodos] = useState([
    { id: 1, text: '学习 React', completed: false },
    { id: 2, text: '写待办应用', completed: true },
  ]);
  const [inputValue, setInputValue] = useState('');

  const addTodo = () => {
    if (inputValue.trim() === '') return;
    const newTodo = {
      id: Date.now(),
      text: inputValue.trim(),
      completed: false,
    };
    setTodos([...todos, newTodo]);
    setInputValue('');
  };

  const toggleTodo = (id: number) => {
    setTodos(
      todos.map(todo =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    );
  };

  const deleteTodo = (id: number) => {
    setTodos(todos.filter(todo => todo.id !== id));
  };

  return (
    <div className="app">
      <h1>📝 待办清单</h1>
      <div className="input-section">
        <input
          type="text"
          value={inputValue}
          onChange={e => setInputValue(e.target.value)}
          placeholder="输入新任务..."
          onKeyDown={e => e.key === 'Enter' && addTodo()}
        />
        <Button onClick={addTodo}>添加</Button>
      </div>
      <ul className="todo-list">
        {todos.length === 0 ? (
          <li className="empty">暂无任务</li>
        ) : (
          todos.map(todo => (
            <li key={todo.id} className="todo-item">
              <label>
                <input
                  type="checkbox"
                  checked={todo.completed}
                  onChange={() => toggleTodo(todo.id)}
                />
                <span className={todo.completed ? 'completed' : ''}>
                  {todo.text}
                </span>
              </label>
              <Button className="delete-btn" onClick={() => deleteTodo(todo.id)}>
                ×
              </Button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
