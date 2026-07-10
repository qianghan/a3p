'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';

interface DocsSidebarContextValue {
  isOpen: boolean;
  toggle: () => void;
  close: () => void;
}

const DocsSidebarContext = createContext<DocsSidebarContextValue | null>(null);

export function DocsSidebarProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  return (
    <DocsSidebarContext.Provider
      value={{ isOpen, toggle: () => setIsOpen((v) => !v), close: () => setIsOpen(false) }}
    >
      {children}
    </DocsSidebarContext.Provider>
  );
}

export function useDocsSidebar(): DocsSidebarContextValue {
  const ctx = useContext(DocsSidebarContext);
  if (!ctx) throw new Error('useDocsSidebar must be used within DocsSidebarProvider');
  return ctx;
}
