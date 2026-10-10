import { createContext, useCallback, useContext, type ReactNode } from "react";

const ProtectedPresentationContext = createContext(false);

/** Protected supplied text must not enter process-wide presentation/parser caches. */
export function ProtectedPresentationProvider({ children }: { children: ReactNode }) {
  return (
    <ProtectedPresentationContext.Provider value={true}>
      {children}
    </ProtectedPresentationContext.Provider>
  );
}

export function useProtectedPresentation(): boolean {
  return useContext(ProtectedPresentationContext);
}

// Gorhom's modal host is not a React portal; restore the originating policy there.
export function useProtectedPresentationBridge() {
  const protectedPresentation = useProtectedPresentation();
  return useCallback(
    (children: ReactNode) => (
      <ProtectedPresentationContext.Provider value={protectedPresentation}>
        {children}
      </ProtectedPresentationContext.Provider>
    ),
    [protectedPresentation],
  );
}
