// src/context/AccessContext.tsx
import React, { createContext, useContext, useState } from 'react';

export type UserRole = 'ADMIN' | 'EDITOR' | 'VIEWER';

interface AccessContextType {
  role: UserRole;
  setRole: (role: UserRole) => void;
  canPerformAction: (action: string) => boolean;
}

const AccessContext = createContext<AccessContextType | undefined>(undefined);

export const AccessProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [role, setRole] = useState<UserRole>('VIEWER');

  const canPerformAction = (action: string) => {
    if (role === 'ADMIN') return true;
    if (role === 'EDITOR' && action !== 'system_config') return true;
    return false; // Viewer can only read
  };

  return (
    <AccessContext.Provider value={{ role, setRole, canPerformAction }}>
      {children}
    </AccessContext.Provider>
  );
};

export const useAccess = () => useContext(AccessContext)!;
