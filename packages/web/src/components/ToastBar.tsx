import { useEffect, useState, useCallback } from 'react';

interface ToastMessage {
  id: number;
  message: string;
  type: 'info' | 'success' | 'error' | 'debug';
}

let toastId = 0;
const listeners: Set<(msg: ToastMessage) => void> = new Set();
const messageHistory: ToastMessage[] = [];

// eslint-disable-next-line react-refresh/only-export-components
export function showToast(message: string, type: 'info' | 'success' | 'error' | 'debug' = 'info') {
  const msg: ToastMessage = { id: ++toastId, message, type };
  messageHistory.push(msg);
  if (messageHistory.length > 50) messageHistory.shift();
  listeners.forEach(l => l(msg));
}

// eslint-disable-next-line react-refresh/only-export-components
export function useFeedToast() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const addMessage = useCallback((msg: ToastMessage) => {
    setMessages(prev => [...prev.slice(-4), msg]);
    setTimeout(() => {
      setMessages(prev => prev.filter(m => m.id !== msg.id));
    }, 5000);
  }, []);

  useEffect(() => {
    listeners.add(addMessage);
    return () => { listeners.delete(addMessage); };
  }, [addMessage]);

  return messages;
}

export function ToastBar({ messages }: { messages: ToastMessage[] }) {
  if (messages.length === 0) return null;

  return (
    <div className="fixed bottom-28 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 max-w-[95vw] w-[400px]">
      {messages.map(msg => (
        <div
          key={msg.id}
          className={`px-4 py-3 rounded-lg shadow-xl text-sm font-medium animate-in fade-in slide-in-from-bottom-4 border-2 ${
            msg.type === 'error' ? 'bg-red-600 text-white border-red-400' :
            msg.type === 'success' ? 'bg-green-600 text-white border-green-400' :
            msg.type === 'debug' ? 'bg-purple-800 text-purple-100 border-purple-600' :
            'bg-purple-600 text-white border-purple-400'
          }`}
        >
          {msg.message}
        </div>
      ))}
    </div>
  );
}
